import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';
import { createPool, builtin, defaultCodecs, param, json } from '@kequtech/pgclear';
import {
  createTenon,
  sql,
  identifier,
  unsafeSql,
  describeQuery,
  generateDefinitions,
  migrate,
  migrationStatus,
  rollback,
} from '@kequtech/tenon-orm';

const run = promisify(execFile),
  clear = process.env.TENON_TRIAL_DRIVER === 'pgclear';
const url = process.env.PGCLEAR_TEST_DATABASE_URL;
assert.equal(decodeURIComponent(new URL(url).pathname.slice(1)), 'pgclear_test');
const marker = 'pgclear_test_m4_' + randomUUID().replaceAll('-', '');
const admin = createPool({ connectionString: url, applicationName: marker, maxConnections: 3 });
const within = { timeout: 15000 };
const count = (n) => (clear ? BigInt(n) : n);
const exact = clear ? '9007199254740993.25' : 9007199254740994;
before(async () => {
  assert.equal(
    (await admin.query('SELECT current_database() AS name')).rows[0].name,
    'pgclear_test',
  );
});
after(() => admin.close());

function settings(namespace, max = 2) {
  const searchPath = `"${namespace}",pg_catalog`;
  return clear
    ? {
        connectionString: url,
        applicationName: marker,
        maxConnections: max,
        startupParameters: { search_path: searchPath },
      }
    : {
        connectionString: url,
        application_name: marker,
        max,
        options: `-c search_path=${searchPath}`,
      };
}
async function fixture(work) {
  const name = 'pgclear_trial_' + randomUUID().replaceAll('-', '');
  await admin.query(`CREATE SCHEMA "${name}"`);
  const db = createTenon({ connection: settings(name) });
  try {
    return await work(db, name);
  } finally {
    await db.close({ timeoutMs: 1000 });
    await admin.query(`DROP SCHEMA "${name}" CASCADE`);
  }
}
async function nativeQuery(pool, text, values = []) {
  return clear ? pool.query({ text, values }) : pool.query(text, values);
}
async function eventually(check) {
  const end = performance.now() + 3000;
  for (;;) {
    if (await check()) return;
    if (performance.now() > end) assert.fail('Owned operation did not reach its barrier.');
    await pause(5);
  }
}

// First external fixture: actual public SQL composition and actual packed driver values.
test(
  'compiled SQL fragments and mutation values pass through the packed package boundary',
  within,
  async () => {
    await fixture(async (db, name) => {
      await admin.query(`CREATE TABLE "${name}".records(id integer PRIMARY KEY, label text)`);
      const values = sql.insertValues([
        { id: 1, label: 'first' },
        { id: 2, label: 'second' },
      ]);
      const inserted = await db.query(sql`INSERT INTO ${identifier(name, 'records')}${values}`);
      assert.equal(inserted.rowCount, count(2));
      const filter = sql.fragment`id >= ${1}`;
      assert.deepEqual(
        await db.query(
          sql`SELECT label FROM ${identifier(name, 'records')} WHERE ${filter} ORDER BY id`,
          { returns: 'many' },
        ),
        [{ label: 'first' }, { label: 'second' }],
      );
      await assert.rejects(db.query(sql`SELECT 1; SELECT 2`), { code: '42601' });
    });
  },
);

test(
  'native values and command metadata identify intentional representation differences',
  within,
  async () => {
    await fixture(async (db) => {
      const result =
        await db.query(sql`SELECT 9007199254740993::bigint AS big,9007199254740993.25::numeric AS decimal,
      ARRAY[9007199254740993.25,NULL]::numeric[] AS decimals,ARRAY[1,NULL,3]::int[] AS integers,
      ARRAY['NULL',NULL,'a,b','a"b','a\\b']::text[] AS texts, TIMESTAMPTZ '2026-10-28 01:02:03.123456+00' AS at,decode('00ff','hex') AS bytes`);
      const row = result.rows[0];
      assert.equal(row.big, clear ? 9007199254740993n : '9007199254740993');
      assert.equal(row.decimal, '9007199254740993.25');
      assert.deepEqual(row.decimals, [exact, null]);
      assert.deepEqual(row.integers, [1, null, 3]);
      assert.deepEqual(row.texts, ['NULL', null, 'a,b', 'a"b', 'a\\b']);
      if (clear) assert.equal(row.at, '2026-10-28 01:02:03.123456+00');
      else assert.ok(row.at instanceof Date);
      assert.deepEqual([...row.bytes], [0, 255]);
      assert.equal(result.rowCount, count(1));
      assert.equal(result.fields[0][clear ? 'dataTypeOid' : 'dataTypeID'], 20);
    });
  },
);

test(
  'guarded write and cardinality failures roll back inside Tenon policy boundaries',
  within,
  async () => {
    await fixture(async (db, name) => {
      await admin.query(`CREATE TABLE "${name}".accounts(id int PRIMARY KEY,n int);`);
      await admin.query(`INSERT INTO "${name}".accounts VALUES(1,10),(2,20)`);
      await assert.rejects(
        db.query(sql`UPDATE ${identifier(name, 'accounts')} SET n=n+100`, {
          affectedRows: { max: 1 },
        }),
        (error) => {
          assert.equal(error.code, 'TENON_AFFECTED_ROWS_MISMATCH');
          assert.equal(error.actual, count(2));
          return true;
        },
      );
      await db.transaction(async (tx) => {
        await assert.rejects(
          tx.query(sql`UPDATE ${identifier(name, 'accounts')} SET n=n+100`, {
            returns: 'one',
            affectedRows: { exact: 2 },
          }),
          { code: 'TENON_CARDINALITY_MISMATCH' },
        );
        await tx.query(sql`UPDATE ${identifier(name, 'accounts')} SET n=n+1 WHERE id=${1}`, {
          affectedRows: { exact: 1 },
        });
      });
      assert.deepEqual((await admin.query(`SELECT n FROM "${name}".accounts ORDER BY id`)).rows, [
        { n: 11 },
        { n: 20 },
      ]);
    });
  },
);

test('concurrent guarded and unguarded calls cannot cross savepoint cleanup', within, async () => {
  await fixture(async (db, name) => {
    await admin.query(`CREATE TABLE "${name}".writes(id int PRIMARY KEY,n int)`);
    await admin.query(`INSERT INTO "${name}".writes VALUES(1,10),(2,20)`);
    await db.transaction(async (tx) => {
      const results = await Promise.allSettled([
        tx.query(sql`UPDATE ${identifier(name, 'writes')} SET n=n+100`, {
          affectedRows: { max: 1 },
        }),
        tx.query(sql`UPDATE ${identifier(name, 'writes')} SET n=n+1 WHERE id=${1}`),
      ]);
      assert.equal(results[0].status, 'rejected');
      assert.equal(results[1].status, 'fulfilled');
    });
    assert.deepEqual((await admin.query(`SELECT n FROM "${name}".writes ORDER BY id`)).rows, [
      { n: 11 },
      { n: 20 },
    ]);
  });
});

test(
  'transaction boundaries and aborted state cannot produce an apparent commit',
  within,
  async () => {
    await fixture(async (db, name) => {
      await admin.query(`CREATE TABLE "${name}".boundaries(n int)`);
      await assert.rejects(
        db.transaction(async (tx) => {
          await tx.query(sql`INSERT INTO ${identifier(name, 'boundaries')} VALUES(1)`);
          await assert.rejects(tx.query(sql`COMMIT`));
          await assert.rejects(tx.query(sql`SELECT 1/0`), { code: '22012' });
        }),
      );
      assert.deepEqual((await admin.query(`SELECT * FROM "${name}".boundaries`)).rows, []);
    });
  },
);

test('valid-invalid-valid serialization keeps results with their callers', within, async () => {
  await fixture(async (db) => {
    const parameter = (value) => (clear ? json(value) : value);
    const results = await Promise.allSettled([
      db.query(sql`SELECT ${parameter({ tag: 'first' })}::jsonb AS value`, { returns: 'one' }),
      db.query(sql`SELECT ${parameter({ bad: 1n })}::jsonb AS value`, { returns: 'one' }),
      db.query(sql`SELECT ${parameter({ tag: 'third' })}::jsonb AS value`, { returns: 'one' }),
    ]);
    assert.equal(results[1].status, 'rejected');
    assert.deepEqual(results[0].value, { value: { tag: 'first' } });
    assert.deepEqual(results[2].value, { value: { tag: 'third' } });
    assert.deepEqual(await db.query(sql`SELECT ${1}::integer AS n`, { returns: 'one' }), { n: 1 });
  });
});

test('borrowed ownership and custom codecs remain application-owned', within, async () => {
  const native = clear
    ? createPool({
        connectionString: url,
        codecs: defaultCodecs.with({
          oid: 23,
          text: { encode: String, decode: (text) => 'int:' + text },
        }),
      })
    : new (await import('pg')).Pool({ connectionString: url });
  const db = createTenon({ connection: native });
  try {
    assert.equal(db.native, native);
    assert.deepEqual(await db.query(sql`SELECT 1 AS n`, { returns: 'one' }), {
      n: clear ? 'int:1' : 1,
    });
    await db.close();
    assert.equal((await nativeQuery(native, 'SELECT 2 AS n')).rows[0].n, clear ? 'int:2' : 2);
    await assert.rejects(db.query(sql`SELECT 3`));
  } finally {
    if (clear) await native.close();
    else await native.end();
  }
});

test(
  'inspection returns origins and exact parameter types without executing nextval',
  within,
  async () => {
    await fixture(async (db, name) => {
      await admin.query(`CREATE TABLE "${name}".described(id int NOT NULL, exact numeric)`);
      await admin.query(`CREATE SEQUENCE "${name}".untouched`);
      const described = await describeQuery({
        connection: url,
        query: `SELECT id,exact FROM "${name}".described WHERE id=$1 AND exact>$2`,
        session: { searchPath: `"${name}",pg_catalog` },
      });
      assert.deepEqual(
        described.parameters.map((p) => p.oid),
        [23, 1700],
      );
      assert.equal(described.columns[0].source.column, 'id');
      assert.equal(described.context.readMappings, clear ? 'pgclear' : 'pg');
      await describeQuery({ connection: url, query: `SELECT nextval('"${name}".untouched')` });
      assert.equal(
        (await admin.query(`SELECT is_called FROM "${name}".untouched`)).rows[0].is_called,
        false,
      );
      await assert.rejects(describeQuery({ connection: url, query: 'SELECT FROM' }), {
        code: '42601',
      });
    });
  },
);

test(
  'generation declarations match runtime defaults under TypeScript 6 and 7',
  within,
  async () => {
    await fixture(async (db, name) => {
      await admin.query(
        `CREATE TABLE "${name}".models(big bigint NOT NULL,decimals numeric[] NOT NULL,at timestamptz NOT NULL,bytes bytea NOT NULL)`,
      );
      const source = await generateDefinitions({ connection: settings(name), namespace: name });
      if (clear) {
        const { generateDefinitions: generateDriverDefinitions } =
          await import('@kequtech/pgclear');
        assert.equal(
          source,
          await generateDriverDefinitions({
            connection: db.native,
            namespace: name,
            excludeTables: ['__tenon_migrations'],
          }),
        );
      }
      const directory = await mkdtemp(join(process.cwd(), 'generated-'));
      try {
        await writeFile(join(directory, 'schema.d.ts'), source);
        await writeFile(
          join(directory, 'consumer.ts'),
          `
        import type {${clear ? 'Database' : 'Rows'}} from './schema.js';
        import type {PgArray} from '@kequtech/pgclear';
        import {sql} from '@kequtech/tenon-orm';
        type Model=${clear ? "Database['models']['row']" : "Rows['models']"};
        declare const row:Model;
        const query=sql<Model>\`SELECT * FROM models\`;
        const big:${clear ? 'bigint' : 'string'}=row.big;
        const decimals:PgArray<${clear ? 'string' : 'number'}>=row.decimals;
        const at:${clear ? 'string' : 'Date | number'}=row.at;
        const bytes:Uint8Array=row.bytes;
        // @ts-expect-error int8 reads must match the selected driver, including inside generated declarations.
        const wrong:${clear ? 'string' : 'bigint'}=row.big;
        void big;void decimals;void at;void bytes;void wrong;
      `,
        );
        for (const compiler of ['typescript', 'typescript-next']) {
          const manifest = new URL(import.meta.resolve(compiler + '/package.json'));
          const metadata = JSON.parse(await readFile(manifest, 'utf8'));
          await run(
            process.execPath,
            [
              new URL(metadata.bin.tsc, manifest).pathname,
              '--ignoreConfig',
              '--noEmit',
              '--strict',
              '--skipLibCheck',
              '--target',
              'ES2024',
              '--module',
              'NodeNext',
              join(directory, 'consumer.ts'),
            ],
            { timeout: 10000 },
          );
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  },
);

test(
  'migration scripts, history, generation and rollback use a held advisory-lock session',
  within,
  async () => {
    await fixture(async (db, name) => {
      const directory = await mkdtemp(join(tmpdir(), 'pgclear-m4-migrations-'));
      const options = { connection: settings(name), namespace: name, directory };
      try {
        await writeFile(
          join(directory, '0001_initial.up.sql'),
          'CREATE TABLE migrated(id int PRIMARY KEY); INSERT INTO migrated VALUES(1),(2);',
        );
        await writeFile(join(directory, '0001_initial.down.sql'), 'DROP TABLE migrated;');
        assert.deepEqual(await migrate(options), ['0001']);
        assert.deepEqual(await migrationStatus(options), { applied: ['0001'], pending: [] });
        assert.deepEqual(
          await db.query(sql`SELECT id FROM ${identifier(name, 'migrated')} ORDER BY id`, {
            returns: 'many',
          }),
          [{ id: 1 }, { id: 2 }],
        );
        await generateDefinitions({ connection: options.connection, namespace: name });
        assert.deepEqual(await rollback(options), ['0001']);
        assert.equal(
          (
            await admin.query({
              text: 'SELECT to_regclass($1) AS table',
              values: [name + '.migrated'],
            })
          ).rows[0].table,
          null,
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  },
);

test(
  'loss between transaction statements cannot send late work to a replacement session',
  within,
  async () => {
    await fixture(async (db, name) => {
      await admin.query(`CREATE TABLE "${name}".lost(n int)`);
      const entered = Promise.withResolvers(),
        resume = Promise.withResolvers(),
        late = Promise.withResolvers();
      let pid;
      const work = db.transaction(async (tx) => {
        await tx.query(sql`INSERT INTO ${identifier(name, 'lost')} VALUES(1)`);
        pid = (await tx.query(sql`SELECT pg_backend_pid() AS pid`, { returns: 'one' })).pid;
        entered.resolve();
        await resume.promise;
        try {
          await tx.query(sql`INSERT INTO ${identifier(name, 'lost')} VALUES(2)`);
          late.reject(Error('Late work succeeded.'));
        } catch (error) {
          late.resolve(error);
          throw error;
        }
      });
      const rejected = assert.rejects(work);
      await entered.promise;
      await admin.query({
        text: 'SELECT pg_terminate_backend($1) WHERE EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND application_name=$2)',
        values: [pid, marker],
      });
      // pg's original Tenon guard notices loss on the next call; pgclear rejects the suspended callback eagerly.
      resume.resolve();
      await rejected;
      assert.ok((await late.promise) instanceof Error);
      assert.deepEqual((await admin.query(`SELECT * FROM "${name}".lost`)).rows, []);
      assert.equal((await db.query(sql`SELECT 3 AS n`, { returns: 'one' })).n, 3);
    });
  },
);

test(
  'owned close follows the selected native contract and permanently fences the pool',
  within,
  async () => {
    const db = createTenon({ connection: settings('public', 1) });
    const results = Promise.allSettled(
      Array.from({ length: 3 }, (_, n) =>
        db.query(sql`SELECT pg_sleep(0.1),${n}::integer AS n`, { returns: 'one' }),
      ),
    );
    await eventually(
      async () =>
        (
          await admin.query({
            text: "SELECT 1 FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND application_name=$1 AND state='active' AND query LIKE '%pg_sleep(0.1)%'",
            values: [marker],
          })
        ).rows.length > 0,
    );
    await db.close({ timeoutMs: 1000 });
    const settled = await results;
    assert.equal(settled[0].status, 'fulfilled');
    assert.equal(settled[0].value.n, 0);
    if (clear)
      assert.deepEqual(
        settled.slice(1).map((result) => result.status),
        ['rejected', 'rejected'],
      );
    else
      assert.deepEqual(
        settled.map((result) => result.value.n),
        [0, 1, 2],
      );
    await assert.rejects(db.query(sql`SELECT 4`));
    await assert.rejects(nativeQuery(db.native, 'SELECT 4'));
  },
);

test(
  'candidate contracts use explicit parameters and reject ambiguous bare values',
  { ...within, skip: !clear },
  async () => {
    await fixture(async (db) => {
      const result = await db.query(
        sql`SELECT ${json(null)}::jsonb IS NULL AS sql_null,
      jsonb_typeof(${json(null)}) AS kind,${param(['9007199254740993.25', null], builtin.numericArray)} AS exact,
      ${param(
        [
          [1, null],
          [2, 3],
        ],
        builtin.int4Array,
      )} AS nested`,
        { returns: 'one' },
      );
      assert.deepEqual(result, {
        sql_null: false,
        kind: 'null',
        exact: ['9007199254740993.25', null],
        nested: [
          [1, null],
          [2, 3],
        ],
      });
      for (const value of [undefined, [1, 2], { enabled: true }, new Date()])
        await assert.rejects(db.query(sql`SELECT ${value}::text`), { code: 'PGCLEAR_ENCODE' });
      await assert.rejects(db.query(sql`SELECT 1 AS n,2 AS n`), { code: 'PGCLEAR_DECODE' });
      assert.deepEqual(await db.query(sql`SELECT 4 AS n`, { returns: 'one' }), { n: 4 });
    });
  },
);

test(
  'tooling acquisitions wait on the same advisory lock without closing a borrowed pool',
  within,
  async () => {
    await fixture(async (db, name) => {
      const directory = await mkdtemp(join(tmpdir(), 'pgclear-m4-locks-'));
      const blocker = await admin.acquire(),
        key = 'tenon:migrations:' + name;
      const options = { connection: db.native, namespace: name, directory };
      try {
        await writeFile(
          join(directory, '0001_locked.up.sql'),
          'CREATE TABLE locked(id int); INSERT INTO locked VALUES(1);',
        );
        await blocker.query({
          text: 'SELECT pg_advisory_lock(hashtextextended($1,0))',
          values: [key],
        });
        const order = [];
        const migration = migrate(options).then((value) => {
          order.push('migrate');
          return value;
        });
        void migration.catch(() => {});
        const waiting = async (minimum) =>
          (
            await admin.query({
              text: `SELECT count(*) AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE l.locktype='advisory' AND NOT l.granted AND a.application_name=$1`,
              values: [marker],
            })
          ).rows[0].n >= BigInt(minimum);
        await eventually(() => waiting(1));
        const generation = generateDefinitions({ connection: db.native, namespace: name }).then(
          (value) => {
            order.push('generate');
            return value;
          },
        );
        void generation.catch(() => {});
        await eventually(() => waiting(2));
        assert.deepEqual(order, []);
        await blocker.query({
          text: 'SELECT pg_advisory_unlock(hashtextextended($1,0))',
          values: [key],
        });
        assert.deepEqual(await migration, ['0001']);
        await generation;
        assert.deepEqual(order, ['migrate', 'generate']);
        assert.equal(
          (await db.query(sql`SELECT id FROM ${identifier(name, 'locked')}`, { returns: 'one' }))
            .id,
          1,
        );
      } finally {
        await blocker.query({
          text: 'SELECT pg_advisory_unlock(hashtextextended($1,0))',
          values: [key],
        });
        await blocker.release();
        await rm(directory, { recursive: true, force: true });
      }
    });
  },
);

test(
  'candidate raw JSON and unknown array OIDs keep the selected driver representation',
  { ...within, skip: !clear },
  async () => {
    await fixture(async (db, name) => {
      await admin.query(`CREATE TYPE "${name}".mood AS ENUM('calm','busy')`);
      const pool = createPool({
        connectionString: url,
        codecs: defaultCodecs.with(builtin.jsonbText),
      });
      const raw = createTenon({ connection: pool });
      try {
        const value = await raw.query(
          sql`SELECT ${param('{"n":9007199254740993}', builtin.jsonbText)} AS exact,
        ${json(null)} AS json_null,NULL::jsonb AS sql_null,ARRAY['calm','busy']::${identifier(name, 'mood')}[] AS moods`,
          { returns: 'one' },
        );
        assert.equal(value.exact, '{"n": 9007199254740993}');
        assert.equal(value.json_null, 'null');
        assert.equal(value.sql_null, null);
        assert.equal(value.moods, '{calm,busy}');
      } finally {
        await raw.close();
        await pool.close();
      }
    });
  },
);

test(
  'Unicode values and column names retain leading U+FEFF through both packed drivers',
  within,
  async () => {
    await fixture(async (db) => {
      const value = await db.query(sql`SELECT chr(65279)||'hello' AS value`, { returns: 'one' });
      assert.deepEqual(value, { value: '\ufeffhello' });
      const names = await db.query(sql`SELECT 1 AS value,2 AS "\ufeffvalue"`, { returns: 'one' });
      assert.deepEqual(names, { value: 1, '\ufeffvalue': 2 });
      const description = await describeQuery({
        connection: url,
        query: 'SELECT 1 AS value,2 AS "\ufeffvalue"',
      });
      assert.deepEqual(
        description.columns.map((column) => column.name),
        ['value', '\ufeffvalue'],
      );
    });
  },
);

test(
  'Unicode text-array elements preserve PostgreSQL data through both packed drivers',
  within,
  async () => {
    await fixture(async (db) => {
      const codes = [
        0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008,
        0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
      ];
      const expressions = codes.flatMap((code) => [
        `chr(${code})||'hello'`,
        `'hello'||chr(${code})`,
        `chr(${code})`,
      ]);
      const expected = codes.flatMap((code) => {
        const char = String.fromCodePoint(code);
        return [char + 'hello', 'hello' + char, char];
      });
      const row = await db.query(
        unsafeSql(`SELECT ARRAY[${expressions.join(',')}]::text[] AS value`, []),
        { returns: 'one' },
      );
      assert.deepEqual(row.value, expected);
    });
  },
);

test(
  'candidate native preparation, bounded streaming and COPY remain usable beside Tenon queries',
  { ...within, skip: !clear },
  async () => {
    await fixture(async (db, name) => {
      const table = `"${name}".native_values`;
      await db.query(unsafeSql(`CREATE TABLE ${table}(n integer PRIMARY KEY)`, []));
      let expired;
      await db.native.withSession(async (session) => {
        expired = await session.prepare(`INSERT INTO ${table} VALUES($1)`);
        await expired.query([1]);
        await assert.rejects(expired.query([undefined]), {
          code: 'PGCLEAR_ENCODE',
          outcome: 'not-sent',
        });
        await expired.query([2]);
        async function* source() {
          yield Buffer.from('3\n4\n');
        }
        assert.equal((await session.copyFrom(`COPY ${table} FROM STDIN`, source())).rowCount, 2n);
        const stream = session.stream(`SELECT n FROM ${table} ORDER BY n`, { batchSize: 2 });
        await stream.fields;
        await assert.rejects(session.query('SELECT 99'), { code: 'PGCLEAR_BUSY' });
        const rows = [];
        for await (const row of stream) rows.push(row.n);
        assert.deepEqual(rows, [1, 2, 3, 4]);
        const chunks = [];
        for await (const chunk of session.copyTo(
          `COPY (SELECT n FROM ${table} ORDER BY n) TO STDOUT`,
        ))
          chunks.push(chunk);
        assert.equal(Buffer.concat(chunks).toString(), '1\n2\n3\n4\n');
      });
      await assert.rejects(expired.query([5]), { code: 'PGCLEAR_EXPIRED' });
      assert.deepEqual(
        await db.query(unsafeSql(`SELECT n FROM ${table} ORDER BY n`, []), { returns: 'many' }),
        [1, 2, 3, 4].map((n) => ({ n })),
      );
    });
  },
);

test(
  'candidate native savepoints roll back failed COPY and recover early stream close',
  { ...within, skip: !clear },
  async () => {
    await fixture(async (db, name) => {
      const table = `"${name}".native_recovery`;
      await db.query(unsafeSql(`CREATE TABLE ${table}(n integer)`, []));
      await db.native.transaction(async (tx) => {
        await assert.rejects(
          tx.savepoint(async (child) => {
            async function* source() {
              yield Buffer.from('1\n');
              throw Error('fixture source');
            }
            await child.copyFrom(`COPY ${table} FROM STDIN`, source());
          }),
          { code: 'PGCLEAR_COPY_SOURCE' },
        );
        const partial = tx.stream('SELECT generate_series(1,10)', { batchSize: 1 });
        for await (const row of partial) {
          assert.ok(row);
          break;
        }
        assert.deepEqual(await partial.completion, { status: 'closed' });
        await tx.query(`INSERT INTO ${table} VALUES(2)`);
      });
      assert.deepEqual(
        await db.query(unsafeSql(`SELECT n FROM ${table}`, []), { returns: 'many' }),
        [{ n: 2 }],
      );
    });
  },
);

test(
  'candidate dedicated listeners coexist with Tenon transactions, reconnect and close permanently',
  { ...within, skip: !clear },
  async () => {
    const { listen } = await import('@kequtech/pgclear');
    const channel = marker + '_notify';
    const messages = [],
      statuses = [];
    const listener = await listen(
      { connectionString: url, applicationName: marker },
      {
        channels: [channel],
        reconnect: true,
        onNotification(value) {
          messages.push(value);
        },
        onStatus(value) {
          statuses.push(value);
        },
      },
    );
    try {
      await fixture(async (db) => {
        const sent = await db.query(
          sql`SELECT pg_backend_pid() AS pid,pg_notify(${channel},${'first'})`,
          { returns: 'one' },
        );
        await eventually(() => messages.length === 1);
        assert.deepEqual(messages[0], { channel, payload: 'first', backendPid: sent.pid });
        await assert.rejects(
          db.transaction(async (tx) => {
            await tx.query(sql`SELECT pg_notify(${channel},${'rolled back'})`);
            throw Error('fixture rollback');
          }),
          /fixture rollback/,
        );
        assert.equal(listener.status.state, 'connected');
        const first = listener.status.session;
        // Terminate only the backend positively identified by this owned direct listener.
        await admin.queryClassic('SELECT pg_terminate_backend($1)', [first.backendPid]);
        await eventually(
          () => listener.status.state === 'connected' && listener.status.generation === 2,
        );
        assert.notEqual(listener.status.session.id, first.id);
        await db.query(sql`SELECT pg_notify(${channel},${'restored'})`);
        await eventually(() => messages.length === 2);
        assert.equal(messages[1].payload, 'restored');
        assert.deepEqual(
          statuses.map((value) => value.state),
          ['connected', 'disconnected', 'reconnecting', 'connected'],
        );
        await listener.close();
        await db.query(sql`SELECT pg_notify(${channel},${'after close'})`);
        await pause(50);
        assert.equal(messages.length, 2);
      });
    } finally {
      await listener.close();
    }
  },
);
