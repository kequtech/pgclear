import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import { getEventListeners } from 'node:events';
import { createPool, type CopyStream, type CopySource } from '../../src/index.js';
import { databaseUrl, testConnection } from '../helpers/database.js';

const within = { timeout: 10000 };
async function output(stream: CopyStream): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}
async function* bytes(...chunks: (string | Uint8Array)[]) {
  for (const chunk of chunks) yield typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
}

test(
  'COPY FROM text chunks and Node Readable feed COPY TO with native command counts and stable bytes',
  within,
  async () => {
    const { client } = await testConnection();
    try {
      await client.query('CREATE TEMP TABLE copy_values (id integer, value text)');
      const first = await client.copyFrom(
        'COPY copy_values FROM STDIN',
        bytes('1\t', 'one\n2\tt', 'wo\n'),
      );
      assert.deepEqual(first, { command: 'COPY', commandTag: 'COPY 2', rowCount: 2n });
      assert.equal(
        (
          await client.copyFrom(
            'COPY copy_values FROM STDIN',
            Readable.from([Buffer.from('3\tthree\n')]),
          )
        ).rowCount,
        1n,
      );
      const stream = client.copyTo('COPY (SELECT * FROM copy_values ORDER BY id) TO STDOUT');
      assert.equal((await output(stream)).toString(), '1\tone\n2\ttwo\n3\tthree\n');
      assert.deepEqual(await stream.completion, {
        status: 'complete',
        result: { command: 'COPY', commandTag: 'COPY 3', rowCount: 3n },
      });
      await stream.close();
      await stream.close();
      assert.equal(client.transactionStatus, 'idle');
      const empty = client.copyTo('COPY (SELECT 1 WHERE false) TO STDOUT');
      assert.equal((await output(empty)).length, 0);
      assert.deepEqual(await empty.completion, {
        status: 'complete',
        result: { command: 'COPY', commandTag: 'COPY 0', rowCount: 0n },
      });
    } finally {
      await client.close();
    }
  },
);

test(
  'binary COPY bytes round trip without interpreting CSV, binary records or chunk boundaries',
  within,
  async () => {
    const { client } = await testConnection();
    try {
      await client.query('CREATE TEMP TABLE copy_binary (n bigint, data bytea, label text)');
      await client.query("INSERT INTO copy_binary VALUES(9007199254740993, '\\x00ff'::bytea, 'é')");
      const stream = client.copyTo('COPY copy_binary TO STDOUT (FORMAT binary)');
      const data = await output(stream);
      assert.equal(data.subarray(0, 11).toString('binary'), 'PGCOPY\n\xff\r\n\0');
      await client.query('TRUNCATE copy_binary');
      async function* fragmented() {
        for (let i = 0; i < data.length; i++) yield data.subarray(i, i + 1);
      }
      assert.equal(
        (await client.copyFrom('COPY copy_binary FROM STDIN (FORMAT binary)', fragmented()))
          .rowCount,
        1n,
      );
      assert.deepEqual((await client.query('SELECT * FROM copy_binary')).rows, [
        { n: 9007199254740993n, data: new Uint8Array([0, 255]), label: 'é' },
      ]);
    } finally {
      await client.close();
    }
  },
);

test(
  'COPY source errors and invalid chunks send CopyFail, observe iterator cleanup and recover the session',
  within,
  async () => {
    const { client } = await testConnection();
    try {
      await client.query('CREATE TEMP TABLE copy_failures (n integer)');
      let cleaned = false;
      const cause = Error('source fixture');
      async function* failing() {
        try {
          yield Buffer.from('1\n');
          throw cause;
        } finally {
          cleaned = true;
        }
      }
      await assert.rejects(client.copyFrom('COPY copy_failures FROM STDIN', failing()), (error) => {
        assert.equal((error as { code: string }).code, 'PGCLEAR_COPY_SOURCE');
        return true;
      });
      assert.equal(cleaned, true);
      assert.equal((await client.query('SELECT count(*) AS n FROM copy_failures')).rows[0]!.n, 0n);
      for (const value of ['2\n', undefined, {}]) {
        const source = {
          async *[Symbol.asyncIterator]() {
            yield value;
          },
        } as CopySource;
        await assert.rejects(client.copyFrom('COPY copy_failures FROM STDIN', source), {
          code: 'PGCLEAR_ENCODE',
          outcome: 'confirmed',
        });
      }
      await assert.rejects(client.copyFrom('COPY copy_failures FROM STDIN', bytes('invalid\n')), {
        code: '22P02',
      });
      assert.equal(
        (await client.copyFrom('COPY copy_failures FROM STDIN', bytes('3\n'))).rowCount,
        1n,
      );
    } finally {
      await client.close();
    }
  },
);

test(
  'COPY rejects invalid input and SQL/direction mismatches without leaving ownership busy',
  within,
  async () => {
    const { client } = await testConnection();
    try {
      for (const source of [null, [], {}, 'x'])
        await assert.rejects(client.copyFrom('COPY missing FROM STDIN', source as never), {
          code: 'PGCLEAR_CONFIGURATION',
          outcome: 'not-sent',
        });
      await assert.rejects(client.copyFrom('SELECT 1', bytes()), { code: 'PGCLEAR_CONFIGURATION' });
      const ordinary = client.copyTo('SELECT 1');
      await assert.rejects(output(ordinary), { code: 'PGCLEAR_CONFIGURATION' });
      const syntax = client.copyTo('COPY');
      await assert.rejects(output(syntax), { code: '42601' });
      await client.query('CREATE TEMP TABLE copy_direction (n integer)');
      const input = client.copyTo('COPY copy_direction FROM STDIN');
      await assert.rejects(output(input), { code: 'PGCLEAR_CONFIGURATION' });
      assert.equal((await client.query('SELECT 1 AS n')).rows[0]!.n, 1);
      await assert.rejects(client.copyFrom('COPY copy_direction TO STDOUT', bytes()), {
        code: 'PGCLEAR_CONFIGURATION',
      });
      await assert.rejects(client.query('SELECT 1'), { code: 'PGCLEAR_CLOSED' });
    } finally {
      await client.close();
    }
  },
);

test(
  'COPY methods exclusively own a held session and start pulling only after the server accepts COPY',
  within,
  async () => {
    const { client } = await testConnection();
    try {
      let pulls = 0;
      async function* source() {
        pulls++;
        yield Buffer.from('1\n');
      }
      await assert.rejects(client.copyFrom('COPY missing_copy_table FROM STDIN', source()), {
        code: '42P01',
      });
      assert.equal(pulls, 0);
      await client.query('CREATE TEMP TABLE copy_exclusive (n integer)');
      const input = client.copyFrom('COPY copy_exclusive FROM STDIN', source());
      await assert.rejects(client.query('SELECT 1'), { code: 'PGCLEAR_BUSY' });
      await assert.rejects(client.prepare('SELECT 1'), { code: 'PGCLEAR_BUSY' });
      await input;
      const stream = client.copyTo('COPY copy_exclusive TO STDOUT');
      await assert.rejects(client.copyFrom('COPY copy_exclusive FROM STDIN', bytes()), {
        code: 'PGCLEAR_BUSY',
      });
      const conflict = client.stream('SELECT 1');
      await assert.rejects(conflict.completion, { code: 'PGCLEAR_BUSY' });
      assert.equal((await output(stream)).toString(), '1\n');
    } finally {
      await client.close();
    }
  },
);

test(
  'COPY FROM and TO participate in transaction/savepoint cleanup and verified rollback',
  within,
  async () => {
    const { client } = await testConnection();
    try {
      await client.query('CREATE TEMP TABLE copy_transaction (n integer)');
      await client.transaction(async (tx) => {
        const statement = await tx.prepare('SELECT 42 AS n');
        await tx.copyFrom('COPY copy_transaction FROM STDIN', bytes('1\n'));
        await tx.savepoint(async (child) => {
          await child.copyFrom('COPY copy_transaction FROM STDIN', bytes('2\n'));
          assert.equal(
            (await output(child.copyTo('COPY copy_transaction TO STDOUT'))).toString(),
            '1\n2\n',
          );
        });
        await assert.rejects(
          tx.savepoint(async (child) => {
            await child.copyFrom('COPY copy_transaction FROM STDIN', bytes('bad\n'));
          }),
          { code: '22P02' },
        );
        assert.equal((await statement.query()).rows[0]!.n, 42);
      });
      assert.equal(
        (await client.query('SELECT count(*) AS n FROM copy_transaction')).rows[0]!.n,
        2n,
      );
      await assert.rejects(
        client.transaction(async (tx) => {
          await tx.copyFrom('COPY copy_transaction FROM STDIN', bytes('3\n'));
          throw Error('rollback fixture');
        }),
        { message: 'rollback fixture' },
      );
      assert.equal(
        (await client.query('SELECT count(*) AS n FROM copy_transaction')).rows[0]!.n,
        2n,
      );
    } finally {
      await client.close();
    }
  },
);

test(
  'COPY output early exit returns closed without a final result and retires its connection',
  within,
  async () => {
    const { client } = await testConnection();
    try {
      const stream = client.copyTo('COPY (SELECT generate_series(1,100000)) TO STDOUT');
      for await (const chunk of stream) {
        assert.ok(chunk.byteLength > 0);
        break;
      }
      assert.deepEqual(await stream.completion, { status: 'closed' });
      await assert.rejects(client.query('SELECT 1'), { code: 'PGCLEAR_CLOSED' });
    } finally {
      await client.close();
    }
  },
);

test(
  'abandoned COPY output closes on callback/lease expiry and cannot be reused',
  within,
  async () => {
    const pool = createPool({ connectionString: databaseUrl(), maxConnections: 1 });
    try {
      let escaped: CopyStream | undefined;
      await assert.rejects(
        pool.withSession(async (session) => {
          escaped = session.copyTo('COPY (SELECT generate_series(1,100000)) TO STDOUT');
          await escaped[Symbol.asyncIterator]().next();
        }),
        { code: 'PGCLEAR_BUSY' },
      );
      assert.deepEqual(await escaped!.completion, { status: 'closed' });
      assert.equal(pool.stats.total, 0);
      const lease = await pool.acquire();
      const stream = lease.copyTo('COPY (SELECT generate_series(1,100000)) TO STDOUT');
      await stream[Symbol.asyncIterator]().next();
      await lease.release();
      assert.deepEqual(await stream.completion, { status: 'closed' });
      assert.equal(pool.stats.total, 0);
    } finally {
      await pool.close();
    }
  },
);

for (const direction of ['in', 'out'] as const)
  test(
    `active COPY ${direction} cancellation fences late source data and removes listeners`,
    within,
    async () => {
      const { client } = await testConnection();
      const controller = new AbortController();
      try {
        await client.query('CREATE TEMP TABLE copy_cancel (n integer)');
        const started = Promise.withResolvers<void>(),
          release = Promise.withResolvers<Uint8Array>();
        const source: CopySource = {
          async *[Symbol.asyncIterator]() {
            started.resolve();
            yield await release.promise;
          },
        };
        const promise =
          direction === 'in'
            ? client.copyFrom('COPY copy_cancel FROM STDIN', source, { signal: controller.signal })
            : client.copyTo('COPY (SELECT generate_series(1,100000)) TO STDOUT', {
                signal: controller.signal,
              });
        const rejected = assert.rejects(promise instanceof Promise ? promise : promise.completion, {
          code: 'PGCLEAR_ABORTED',
        });
        if (direction === 'in') await started.promise;
        else await (promise as CopyStream)[Symbol.asyncIterator]().next();
        controller.abort();
        // Let the async generator finish its pending next before iterator.return cleanup.
        release.resolve(Buffer.from('123\n'));
        await rejected;
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
        await assert.rejects(client.query('SELECT 1'), { code: 'PGCLEAR_CLOSED' });
      } finally {
        await client.close();
      }
    },
  );

test(
  'accepted unawaited COPY FROM drains before callback success and source byte limits do not cap the whole transfer',
  within,
  async () => {
    const pool = createPool({
      connectionString: databaseUrl(),
      maxConnections: 1,
      maxResultBytes: 128,
    });
    let pending: Promise<unknown> | undefined;
    try {
      await pool.withSession(async (session) => {
        await session.query('CREATE TEMP TABLE copy_unawaited (n integer)');
        pending = session.copyFrom(
          'COPY copy_unawaited FROM STDIN',
          bytes(Array.from({ length: 1000 }, (_, i) => String(i) + '\n').join('')),
        );
      });
      await pending;
      assert.equal(
        (await pool.query('SELECT count(*) AS n FROM copy_unawaited')).rows[0]!.n,
        1000n,
      );
      await pool.withSession(async (session) => {
        const stream = session.copyTo('COPY copy_unawaited TO STDOUT');
        const data = await output(stream);
        assert.equal(data.toString().split('\n').length, 1001);
      });
    } finally {
      await pool.close();
    }
  },
);

for (const direction of ['in', 'out'] as const)
  test(`COPY ${direction} deadline includes source/consumer idle time`, within, async () => {
    const { client } = await testConnection();
    try {
      await client.query('CREATE TEMP TABLE copy_timeout (n integer)');
      if (direction === 'in') {
        const input: CopySource = {
          [Symbol.asyncIterator]() {
            return {
              next() {
                return new Promise(() => {});
              },
              async return() {
                return { done: true, value: undefined };
              },
            };
          },
        };
        await assert.rejects(
          client.copyFrom('COPY copy_timeout FROM STDIN', input, { timeoutMs: 25 }),
          { code: 'PGCLEAR_TIMEOUT', outcome: 'confirmed' },
        );
      } else {
        const stream = client.copyTo('COPY (SELECT generate_series(1,1000)) TO STDOUT', {
          timeoutMs: 25,
        });
        await stream[Symbol.asyncIterator]().next();
        await assert.rejects(stream.completion, { code: 'PGCLEAR_TIMEOUT', outcome: 'confirmed' });
      }
      await assert.rejects(client.query('SELECT 1'), { code: 'PGCLEAR_CLOSED' });
    } finally {
      await client.close();
    }
  });

test(
  'COPY output enforces per-chunk byte bounds and strict single-consumer iteration',
  within,
  async () => {
    const { client } = await testConnection({ maxResultBytes: 128 });
    try {
      const stream = client.copyTo("COPY (SELECT repeat('x',200)) TO STDOUT");
      await assert.rejects(output(stream), { code: 'PGCLEAR_RESULT_LIMIT' });
    } finally {
      await client.close();
    }
    const { client: ordinary } = await testConnection();
    try {
      const stream = ordinary.copyTo('COPY (SELECT generate_series(1,3)) TO STDOUT');
      const iterator = stream[Symbol.asyncIterator]();
      assert.throws(() => stream[Symbol.asyncIterator](), { code: 'PGCLEAR_BUSY' });
      const pending = iterator.next();
      await assert.rejects(iterator.next(), { code: 'PGCLEAR_BUSY' });
      await pending;
      await iterator.return!();
      assert.deepEqual(await stream.completion, { status: 'closed' });
    } finally {
      await ordinary.close();
    }
  },
);

test(
  'cancelling a waiting Node Readable destroys it before returning the COPY failure',
  within,
  async () => {
    const { client } = await testConnection();
    const controller = new AbortController(),
      started = Promise.withResolvers<void>();
    const source = new Readable({
      read() {
        started.resolve();
      },
    });
    try {
      await client.query('CREATE TEMP TABLE copy_readable_cancel (n integer)');
      const failed = assert.rejects(
        client.copyFrom('COPY copy_readable_cancel FROM STDIN', source, {
          signal: controller.signal,
        }),
        { code: 'PGCLEAR_ABORTED' },
      );
      await started.promise;
      controller.abort();
      await failed;
      assert.equal(source.destroyed, true);
    } finally {
      source.destroy();
      await client.close();
    }
  },
);

test('COPY reserves its scope before invoking source getters or iterators', within, async () => {
  const { client } = await testConnection();
  const checks: Promise<void>[] = [];
  const checkOwnership = () => {
    checks.push(assert.rejects(client.query('SELECT 99'), { code: 'PGCLEAR_BUSY' }));
  };
  try {
    await client.query('CREATE TEMP TABLE copy_reentrant (n integer)');
    const source: CopySource = {
      get [Symbol.asyncIterator]() {
        checkOwnership();
        return async function* () {
          checkOwnership();
          yield Buffer.from('1\n');
        };
      },
    };
    assert.equal((await client.copyFrom('COPY copy_reentrant FROM STDIN', source)).rowCount, 1n);
    await Promise.all(checks);
    assert.ok(checks.length >= 2);
    assert.deepEqual((await client.query('SELECT n FROM copy_reentrant')).rows, [{ n: 1 }]);
  } finally {
    await client.close();
  }
});
