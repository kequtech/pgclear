import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPool, type CopyStream, type PreparedStatement } from '../../src/index.js';
import { databaseUrl } from '../helpers/database.js';

const seed = 0x5a5b5c;

test(
  `mixed M5 lifetimes preserve session state and recover ownership (seed ${seed})`,
  { timeout: 15000 },
  async () => {
    const pool = createPool({ connectionString: databaseUrl(), maxConnections: 1 });
    let random = seed,
      pid: number | undefined;
    const expected = new Set<number>();
    const choose = () => {
      random ^= random << 13;
      random ^= random >>> 17;
      random ^= random << 5;
      return (random >>> 0) % 5;
    };
    try {
      for (let step = 0; step < 25; step++) {
        const lease = await pool.acquire();
        if (pid !== lease.info.backendPid) {
          expected.clear();
          pid = lease.info.backendPid;
        }
        await lease.query('CREATE TEMP TABLE IF NOT EXISTS m5_sequence (n integer PRIMARY KEY)');
        let expired: PreparedStatement | undefined;
        const value = step * 10;
        const action = choose();
        if (action === 0) {
          expired = await lease.prepare('INSERT INTO m5_sequence VALUES($1)');
          await expired.query([value]);
          expected.add(value);
          await assert.rejects(expired.query([NaN]), {
            code: 'PGCLEAR_ENCODE',
            outcome: 'not-sent',
          });
          await expired.query([value + 1]);
          expected.add(value + 1);
        } else if (action === 1) {
          const stream = lease.stream('SELECT n FROM m5_sequence ORDER BY n', { batchSize: 2 });
          const rows = [];
          for await (const row of stream) rows.push(row.n);
          assert.deepEqual(
            rows,
            [...expected].sort((a, b) => a - b),
          );
          assert.equal((await stream.completion).status, 'complete');
        } else if (action === 2) {
          async function* source() {
            yield Buffer.from(String(value) + '\n');
          }
          await lease.copyFrom('COPY m5_sequence FROM STDIN', source());
          expected.add(value);
          const chunks: Uint8Array[] = [];
          const output = lease.copyTo('COPY (SELECT n FROM m5_sequence ORDER BY n) TO STDOUT');
          for await (const chunk of output) chunks.push(chunk);
          assert.equal(
            Buffer.concat(chunks).toString(),
            [...expected]
              .sort((a, b) => a - b)
              .map((n) => String(n) + '\n')
              .join(''),
          );
        } else if (action === 3) {
          await lease.transaction(async (tx) => {
            await assert.rejects(
              tx.savepoint(async (child) => {
                async function* source() {
                  yield Buffer.from(String(value) + '\n');
                }
                await child.copyFrom('COPY m5_sequence FROM STDIN', source());
                const abandoned = child.stream('SELECT generate_series(1,10)', { batchSize: 1 });
                await abandoned.fields;
              }),
              { code: 'PGCLEAR_BUSY' },
            );
            const owned = await tx.prepare('INSERT INTO m5_sequence VALUES($1)');
            await owned.query([value + 1]);
          });
          expected.add(value + 1);
        } else {
          const output: CopyStream = lease.copyTo('COPY (SELECT generate_series(1,100)) TO STDOUT');
          for await (const chunk of output) {
            assert.ok(chunk.length > 0);
            break;
          }
          assert.deepEqual(await output.completion, { status: 'closed' });
          await lease.release();
          continue;
        }
        assert.deepEqual(
          (await lease.query('SELECT n FROM m5_sequence ORDER BY n')).rows.map((row) => row.n),
          [...expected].sort((a, b) => a - b),
          `step ${step}, action ${action}`,
        );
        await lease.release();
        if (expired) await assert.rejects(expired.query([value + 2]), { code: 'PGCLEAR_EXPIRED' });
        const next = await pool.acquire();
        assert.equal(
          (
            await next.query(
              "SELECT count(*) AS n FROM pg_prepared_statements WHERE name LIKE 'pgclear_statement_%'",
            )
          ).rows[0]!.n,
          0n,
        );
        // The inspection query itself owns the unnamed portal; no other cursor may remain.
        assert.deepEqual((await next.query('SELECT name FROM pg_cursors')).rows, [{ name: '' }]);
        await next.release();
      }
    } finally {
      await pool.close();
    }
  },
);

test('unnamed stream and COPY portals support manual transactions and savepoint recovery', async () => {
  const pool = createPool({ connectionString: databaseUrl(), maxConnections: 1 });
  const lease = await pool.acquire();
  const pid = lease.info.backendPid;
  try {
    await lease.query('CREATE TEMP TABLE m5_manual (n integer)');
    await lease.query('BEGIN');
    const stream = lease.stream('SELECT generate_series(1,3) AS n', { batchSize: 2 });
    const values = [];
    for await (const row of stream) values.push(row.n);
    assert.deepEqual(values, [1, 2, 3]);
    assert.equal((await stream.completion).status, 'complete');
    assert.equal(lease.transactionStatus, 'transaction');
    async function* source() {
      yield Buffer.from('7\n');
    }
    await lease.copyFrom('COPY m5_manual FROM STDIN', source());
    const output = lease.copyTo('COPY m5_manual TO STDOUT');
    const chunks = [];
    for await (const chunk of output) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), '7\n');
    assert.equal(lease.transactionStatus, 'transaction');

    await lease.query('SAVEPOINT recover');
    async function* failing() {
      yield Buffer.from('8\n');
      throw new Error('source failed inside savepoint');
    }
    await assert.rejects(lease.copyFrom('COPY m5_manual FROM STDIN', failing()), {
      code: 'PGCLEAR_COPY_SOURCE',
    });
    assert.equal(lease.transactionStatus, 'failed');
    await lease.query('ROLLBACK TO SAVEPOINT recover');
    await lease.query('RELEASE SAVEPOINT recover');
    const partial = lease.stream('SELECT generate_series(1,10)', { batchSize: 1 });
    for await (const row of partial) {
      assert.ok(row);
      break;
    }
    assert.deepEqual(await partial.completion, { status: 'closed' });
    assert.equal(lease.transactionStatus, 'transaction');
    assert.deepEqual((await lease.query('SELECT n FROM m5_manual')).rows, [{ n: 7 }]);
    await lease.query('COMMIT');
    await lease.release();
    const next = await pool.acquire();
    assert.equal(next.info.backendPid, pid);
    assert.equal(next.transactionStatus, 'idle');
    assert.deepEqual((await next.query('SELECT n FROM m5_manual')).rows, [{ n: 7 }]);
    await next.release();
  } finally {
    await pool.close();
  }
});
