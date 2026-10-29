/** Compile-only usage contracts. These functions are not runtime tests. */
import {
  builtin,
  connect,
  createPool,
  defaultCodecs,
  generateDefinitions,
  listen,
  json,
  param,
  sql,
  type Codec,
  type ConnectionOptions,
  type GenerateOptions,
  type Pool,
  type Session,
} from '../../src/index.js';

export function decoderRepresentation(oid: number): string | undefined {
  return defaultCodecs.typescript(oid);
}

export async function schemaTypes(connection: Pool | Session): Promise<string> {
  const options: GenerateOptions = { connection, namespace: 'public', timeoutMs: 5000 };
  const source: string = await generateDefinitions(options);
  // @ts-expect-error checking/file output remain consumer responsibilities
  generateDefinitions({ connection, check: true });
  return source;
}

export async function standalone(connectionString: string) {
  const connection = await connect({ connectionString });
  try {
    const result = await connection.queryClassic<{ id: number; balance: string }>(
      'SELECT id, balance FROM accounts WHERE id = $1',
      [42],
    );
    const count: number | null = result.rowCount;
    return { first: result.rows[0], count };
  } finally {
    await connection.close();
  }
}

export async function poolUsage(connectionString: string) {
  const pool = createPool({ connectionString, maxConnections: 4 });
  try {
    await pool.queryClassic('SELECT $1::jsonb AS payload, $2::integer[] AS values', [
      param({ tag: 'example' }, builtin.jsonb),
      param([1, null, 3], builtin.int4Array),
    ]);
    const result = await pool.queryClassic<readonly [number, number]>('SELECT 1 AS n, 2 AS n', [], {
      rowMode: 'array',
    });
    const pair: readonly [number, number] | undefined = result.rows[0];
    return pair;
  } finally {
    await pool.close({ timeoutMs: 5000 });
  }
}

export async function queryEntryPoints(session: Session) {
  type Database = { user: { id: number; name: string; secret: string } };
  type Selected = Pick<Database['user'], 'id' | 'name'>;
  const tagged = await session.query(sql<Selected>`SELECT id, name FROM users WHERE id = ${42}`);
  const classic = await session.queryClassic<Selected>(
    'SELECT id, name FROM users WHERE id = $1',
    [42],
  );
  const tuple = await session.query(sql<readonly [number]>`SELECT ${42}::integer`, {
    rowMode: 'array',
  });
  const tupleValue: number | undefined = tuple.rows[0]?.[0];
  const untypedArray = await session.query(sql`SELECT ${42}::integer`, { rowMode: 'array' });
  // @ts-expect-error Untyped array-row values remain unknown.
  const untypedNumber: number = untypedArray.rows[0]![0];
  void tupleValue;
  const name: string | undefined = tagged.rows[0]?.name;
  // @ts-expect-error The tag's row type excludes secret.
  tagged.rows[0]?.secret;
  // @ts-expect-error A nested query cannot splice SQL into a value-only tag.
  sql`SELECT ${sql`1`}`;
  // @ts-expect-error query accepts only tagged SQL, not raw SQL.
  session.query('SELECT 1');
  // @ts-expect-error A plain tuple is not a tag result.
  session.query(['SELECT 1', []]);
  // @ts-expect-error Statement objects belong to neither query entrypoint.
  session.query({ text: 'SELECT 1', values: [] });
  // @ts-expect-error query's second argument is options, not values.
  session.query(sql`SELECT 1`, [42]);
  // @ts-expect-error queryClassic takes SQL text, not a tag result.
  session.queryClassic(sql`SELECT 1`, []);
  return { tagged, classic, name };
}

export async function descriptionAndPreparation(session: Session) {
  const description = await session.describe('SELECT $1::integer AS value');
  const prepared = await session.prepare({
    text: 'SELECT $1::integer AS value',
    parameterTypes: [23],
  });
  try {
    const result = await prepared.query<{ value: number }>([42]);
    return { description, result };
  } finally {
    await prepared.close();
  }
}

export async function jsonAndExactValues(session: Session) {
  const distinctions = await session.queryClassic(
    'SELECT $1::jsonb IS NULL AS missing, jsonb_typeof($2::jsonb) AS kind, $3::jsonb AS text',
    [null, json(null), json('text')],
  );
  await session.queryClassic('SELECT $1::numeric[] AS exact, $2::json AS payload', [
    param(['9007199254740993.25', null], builtin.numericArray),
    json([1, 2], 'json'),
  ]);
  return distinctions;
}

export async function rawJsonValues(connectionString: string) {
  const pool = createPool({
    connectionString,
    codecs: defaultCodecs.with(builtin.jsonText).with(builtin.jsonbText),
  });
  try {
    return await pool.queryClassic<{ payload: string }>('SELECT $1::jsonb AS payload', [
      param('{"n":9007199254740993}', builtin.jsonbText),
    ]);
  } finally {
    await pool.close();
  }
}

export async function transactions(pool: Pool) {
  return pool.transaction(
    async (tx) => {
      await tx.queryClassic('UPDATE accounts SET balance = balance - $1 WHERE id = $2', [10, 1]);
      await tx.savepoint(async (child) => {
        await child.queryClassic(
          'UPDATE accounts SET balance = balance + $1 WHERE id = $2',
          [10, 2],
        );
      });
      // Every call inside the savepoint used its child; the parent is active again here.
      return tx.queryClassic('SELECT current_timestamp::text AS recorded_at', []);
    },
    { isolation: 'serializable' },
  );
}

export async function migrationLock(pool: Pool) {
  return pool.withSession(async (session) => {
    await session.queryClassic('SELECT pg_advisory_lock(42)', []);
    try {
      return await session.script('CREATE TABLE IF NOT EXISTS example (id integer); SELECT 1;');
    } finally {
      await session.queryClassic('SELECT pg_advisory_unlock(42)', []);
    }
  });
}

export async function streamRows(pool: Pool) {
  return pool.withSession(async (session) => {
    const stream = session.stream<{ id: number }>('SELECT generate_series(1, 1000) AS id', {
      batchSize: 100,
    });
    for await (const row of stream) {
      if (row.id === 5) break; // Awaits portal cleanup before the next query.
    }
    await stream.completion;
    return session.queryClassic('SELECT 1', []);
  });
}

export async function copy(session: Session, source: AsyncIterable<Uint8Array>) {
  await session.copyFrom('COPY example (id) FROM STDIN', source);
  const output = session.copyTo('COPY example TO STDOUT');
  for await (const chunk of output) {
    const bytes: Uint8Array = chunk;
    void bytes;
  }
  return output.completion;
}

export async function notifications(options: ConnectionOptions, signal: AbortSignal) {
  const received: string[] = [];
  const listener = await listen(options, {
    channels: ['jobs_changed'],
    reconnect: true,
    signal,
    onNotification: ({ payload }) => {
      received.push(payload);
    },
  });
  return { received, close: () => listener.close() };
}

export async function customCodecs(connectionString: string) {
  const int4AsText: Codec<string> = {
    ...builtin.text,
    oid: builtin.int4.oid,
  };
  const pool = createPool({ connectionString, codecs: defaultCodecs.with(int4AsText) });
  try {
    return await pool.queryClassic<{ id: string }>('SELECT 42::integer AS id', []);
  } finally {
    await pool.close();
  }
}

export async function abort(pool: Pool) {
  return pool.queryClassic('SELECT pg_sleep(10)', [], { signal: AbortSignal.timeout(100) });
}

export function invalidUsage(pool: Pool, session: Session) {
  // @ts-expect-error Int8 parameters use exact strings, not bigint values.
  void pool.queryClassic('SELECT $1', [1n]);
  // @ts-expect-error The built-in int8 codec accepts strings.
  param(1n, builtin.int8);
  // @ts-expect-error The built-in int8 array codec accepts string elements.
  param([1], builtin.int8Array);
  // @ts-expect-error Undefined is not a parameter value.
  void pool.queryClassic('SELECT $1', [undefined]);
  // @ts-expect-error Objects need an explicit codec.
  void pool.queryClassic('SELECT $1', [{ enabled: true }]);
  // @ts-expect-error Arrays need an explicit codec.
  void pool.queryClassic('SELECT $1', [[1, 2]]);
  // @ts-expect-error Describe accepts type hints, never bound execution values.
  void pool.describe({ text: 'SELECT $1', values: [1] });
  // @ts-expect-error A pool cannot execute multi-statement scripts without a held session.
  void pool.script('SELECT 1; SELECT 2');
  void pool.transaction(async (tx) => {
    // @ts-expect-error Callback-scoped transaction handles cannot release the pool lease.
    await tx.release();
  });
  // @ts-expect-error An explicit codec checks the value type.
  param('wrong', builtin.int4);
  // @ts-expect-error Exact numeric array inputs are strings, never rounded JS numbers.
  param([1.25], builtin.numericArray);
  // @ts-expect-error JSON helpers select only PostgreSQL json or jsonb.
  json(null, 'text');
  // @ts-expect-error Session callbacks do not own the standalone connection's close.
  void session.close();
}
