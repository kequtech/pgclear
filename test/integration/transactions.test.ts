import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPool, type Transaction } from '../../src/index.js';
import { databaseUrl, ownedName, testConnection } from '../helpers/database.js';
const within = { timeout: 10000 };

test(
  'managed transactions commit, roll back callback errors and expire callback handles',
  within,
  async () => {
    const { client } = await testConnection();
    let saved: Transaction | undefined;
    try {
      await client.query('CREATE TEMP TABLE tx_values(n int)');
      const result = await client.transaction(async (tx) => {
        saved = tx;
        await tx.query('INSERT INTO tx_values VALUES(1)');
        return 'done';
      });
      assert.equal(result, 'done');
      assert.equal(client.transactionStatus, 'idle');
      await assert.rejects(saved!.query('SELECT 1'), { code: 'PGCLEAR_EXPIRED' });
      await assert.rejects(
        client.transaction(async (tx) => {
          await tx.query('INSERT INTO tx_values VALUES(2)');
          throw Error('fixture');
        }),
        /fixture/,
      );
      assert.deepEqual((await client.query('SELECT * FROM tx_values')).rows, [{ n: 1 }]);
      await client.transaction(async (tx) => {
        await tx.query('SAVEPOINT manual');
        await assert.rejects(tx.query('SELECT 1/0'), { code: '22012' });
        await tx.query('ROLLBACK TO SAVEPOINT manual');
        await tx.query('INSERT INTO tx_values VALUES(3)');
      });
      assert.deepEqual((await client.query('SELECT * FROM tx_values ORDER BY n')).rows, [
        { n: 1 },
        { n: 3 },
      ]);
      await assert.rejects(
        client.transaction(async (tx) => {
          await assert.rejects(tx.query('SELECT 1/0'));
        }),
        { code: 'PGCLEAR_TRANSACTION_STATE' },
      );
      assert.equal(client.transactionStatus, 'idle');
    } finally {
      await client.close();
    }
  },
);

test('savepoint callbacks own the full scope and recover SQL failures', within, async () => {
  const { client } = await testConnection();
  let saved: Transaction | undefined;
  const entered = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>();
  try {
    await client.query('CREATE TEMP TABLE savepoint_values(n int)');
    await client.transaction(async (tx) => {
      await tx.query('INSERT INTO savepoint_values VALUES(1)');
      const child = tx.savepoint(async (scope) => {
        saved = scope;
        await scope.query('INSERT INTO savepoint_values VALUES(2)');
        entered.resolve();
        await resume.promise;
        throw Error('child');
      });
      const rejected = assert.rejects(child, /child/);
      await entered.promise;
      await assert.rejects(tx.query('SELECT 1'), { code: 'PGCLEAR_BUSY' });
      await assert.rejects(
        tx.savepoint(async () => {}),
        { code: 'PGCLEAR_BUSY' },
      );
      await assert.rejects(client.query('SELECT 1'), { code: 'PGCLEAR_BUSY' });
      resume.resolve();
      await rejected;
      await assert.rejects(saved!.query('SELECT 1'), { code: 'PGCLEAR_EXPIRED' });
      await assert.rejects(
        tx.savepoint(async (scope) => {
          await scope.query('SELECT 1/0');
        }),
        { code: '22012' },
      );
      await tx.savepoint(async (scope) => {
        await scope.savepoint(async (nested) => {
          await nested.query('INSERT INTO savepoint_values VALUES(3)');
        });
      });
    });
    assert.deepEqual((await client.query('SELECT * FROM savepoint_values ORDER BY n')).rows, [
      { n: 1 },
      { n: 3 },
    ]);
  } finally {
    resume.resolve();
    await client.close();
  }
});

test(
  'failed savepoint recovery poisons commit and preserves work and cleanup errors',
  within,
  async () => {
    const { client } = await testConnection();
    try {
      await client.query('CREATE TEMP TABLE poisoned(n int)');
      await assert.rejects(
        client.transaction(async (tx) => {
          await tx.query('INSERT INTO poisoned VALUES(1)');
          await assert.rejects(
            tx.savepoint(async (child) => {
              // Explicitly destroy the owned savepoint through SQL; recovery must fail visibly.
              await child.query('ROLLBACK');
              throw Error('work failed');
            }),
            (error) => {
              assert.ok(error instanceof AggregateError);
              assert.match(String(error.errors[0]), /work failed/);
              return true;
            },
          );
        }),
        { code: 'PGCLEAR_TRANSACTION_STATE' },
      );
      assert.deepEqual((await client.query('SELECT * FROM poisoned')).rows, []);
    } finally {
      await client.close();
    }
  },
);

test(
  'accepted unawaited operations finish before commit and cannot enter the next scope',
  within,
  async () => {
    const { client } = await testConnection();
    let pending: Promise<unknown> | undefined;
    try {
      await client.query('CREATE TEMP TABLE accepted_work(n int)');
      await client.transaction(async (tx) => {
        pending = tx.query('INSERT INTO accepted_work SELECT 1 FROM pg_sleep(0.02)');
      });
      await pending;
      assert.deepEqual((await client.query('SELECT * FROM accepted_work')).rows, [{ n: 1 }]);
      const entered = Promise.withResolvers<void>();
      await assert.rejects(
        client.transaction(async (tx) => {
          const abandoned = tx.savepoint(async (child) => {
            entered.resolve();
            await new Promise(() => {});
            return child.query('SELECT 1');
          });
          void abandoned.catch(() => {});
          await entered.promise;
        }),
        { code: 'PGCLEAR_BUSY' },
      );
      assert.equal(client.transactionStatus, 'idle');
    } finally {
      await client.close();
    }
  },
);

test(
  'transaction options reach PostgreSQL and invalid options perform no acquisition',
  within,
  async () => {
    const pool = createPool({
      connectionString: databaseUrl(),
      applicationName: ownedName(),
      maxConnections: 1,
    });
    try {
      await assert.rejects(
        pool.transaction(async () => {}, { deferrable: true }),
        { code: 'PGCLEAR_CONFIGURATION' },
      );
      assert.equal(pool.stats.total, 0);
      const value = await pool.transaction(
        async (tx) => (await tx.query('SHOW transaction_isolation')).rows[0]!.transaction_isolation,
        { isolation: 'serializable', readOnly: true, deferrable: true },
      );
      assert.equal(value, 'serializable');
      await assert.rejects(
        pool.transaction(
          async (tx) => {
            await tx.query('CREATE TABLE forbidden_in_readonly(n int)');
          },
          { readOnly: true },
        ),
        { code: '25006' },
      );
    } finally {
      await pool.close();
    }
  },
);

test(
  'backend loss between statements fences late callback work without replacing its session',
  within,
  async () => {
    const pool = createPool({
      connectionString: databaseUrl(),
      applicationName: ownedName(),
      maxConnections: 2,
    });
    const { client: observer } = await testConnection();
    const entered = Promise.withResolvers<Transaction>(),
      resume = Promise.withResolvers<void>(),
      late = Promise.withResolvers<unknown>();
    try {
      const work = pool.transaction(async (tx) => {
        await tx.query('SELECT 1');
        entered.resolve(tx);
        await resume.promise;
        try {
          await tx.query('SELECT 2');
          late.reject(Error('Expired callback succeeded.'));
        } catch (error) {
          late.resolve(error);
        }
      });
      const rejected = assert.rejects(work, { code: 'PGCLEAR_CONNECTION_LOST' }),
        tx = await entered.promise;
      const pid = tx.info.backendPid;
      const matches = await observer.query({
        text: 'SELECT application_name FROM pg_stat_activity WHERE pid=$1',
        values: [pid],
      });
      assert.ok(String(matches.rows[0]!.application_name).startsWith('pgclear_test_'));
      await observer.query({
        text: 'SELECT pg_terminate_backend($1) WHERE EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND application_name=$2)',
        values: [pid, String(matches.rows[0]!.application_name)],
      });
      await rejected;
      resume.resolve();
      assert.equal(((await late.promise) as { code: string }).code, 'PGCLEAR_EXPIRED');
      assert.equal(
        await pool.transaction(async (other) => (await other.query('SELECT 3 AS n')).rows[0]!.n),
        3,
      );
    } finally {
      resume.resolve();
      await Promise.all([pool.close(), observer.close()]);
    }
  },
);

test(
  'whole-callback deadlines retire the session even when user JavaScript never settles',
  within,
  async () => {
    const pool = createPool({
      connectionString: databaseUrl(),
      applicationName: ownedName(),
      maxConnections: 1,
    });
    let late: Transaction | undefined;
    try {
      await assert.rejects(
        pool.transaction(
          async (tx) => {
            late = tx;
            await tx.query('SELECT 1');
            await new Promise(() => {});
          },
          { timeoutMs: 30 },
        ),
        { code: 'PGCLEAR_TIMEOUT', outcome: 'unknown' },
      );
      await assert.rejects(late!.query('SELECT 2'), { code: 'PGCLEAR_EXPIRED' });
      assert.equal(pool.stats.total, 0);
      await assert.rejects(
        pool.withSession(
          async () => {
            await new Promise(() => {});
          },
          { timeoutMs: 20 },
        ),
        { code: 'PGCLEAR_TIMEOUT' },
      );
      assert.equal((await pool.query('SELECT 3 AS n')).rows[0]!.n, 3);
    } finally {
      await pool.close();
    }
  },
);

test(
  'backend loss during an active transaction does not affect another transaction',
  within,
  async () => {
    const applicationName = ownedName(),
      pool = createPool({ connectionString: databaseUrl(), applicationName, maxConnections: 2 });
    const { client: observer } = await testConnection();
    const started = Promise.withResolvers<Transaction>();
    try {
      const task = pool.transaction(async (tx) => {
        started.resolve(tx);
        await tx.query('SELECT pg_sleep(30)');
      });
      const rejected = assert.rejects(task),
        victim = await started.promise;
      for (let tries = 0; ; tries++) {
        const row = (
          await observer.query({
            text: 'SELECT state,query FROM pg_stat_activity WHERE pid=$1 AND application_name=$2',
            values: [victim.info.backendPid, applicationName],
          })
        ).rows[0];
        if (row?.state === 'active' && row.query === 'SELECT pg_sleep(30)') break;
        if (tries > 100) assert.fail('Owned transaction did not dispatch.');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const healthy = pool.transaction(async (tx) => {
        await tx.query('SELECT pg_sleep(0.02)');
        return (await tx.query('SELECT 5 AS n')).rows[0]!.n;
      });
      await observer.query({
        text: 'SELECT pg_terminate_backend($1) WHERE EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND application_name=$2)',
        values: [victim.info.backendPid, applicationName],
      });
      await rejected;
      assert.equal(await healthy, 5);
      await assert.rejects(victim.query('SELECT 1'), { code: 'PGCLEAR_EXPIRED' });
    } finally {
      await Promise.all([pool.close(), observer.close()]);
    }
  },
);

test(
  'verified transaction rollback and ordinary SQL errors permit pool connection reuse',
  within,
  async () => {
    const pool = createPool({
      connectionString: databaseUrl(),
      applicationName: ownedName(),
      maxConnections: 1,
    });
    let pid = 0;
    try {
      await assert.rejects(
        pool.transaction(async (tx) => {
          pid = tx.info.backendPid;
          await tx.query('SELECT 1/0');
        }),
        { code: '22012' },
      );
      const lease = await pool.acquire();
      assert.equal(lease.info.backendPid, pid);
      await lease.release();
      await assert.rejects(pool.query('SELECT 1/0'), { code: '22012' });
      const next = await pool.acquire();
      assert.equal(next.info.backendPid, pid);
      await next.release();
    } finally {
      await pool.close();
    }
  },
);

test(
  'a transaction deadline behind earlier session work removes only the unsent scope',
  within,
  async () => {
    const { client } = await testConnection();
    try {
      const prior = client.query('SELECT pg_sleep(0.08), 1 AS n');
      await assert.rejects(
        client.transaction(
          async (tx) => {
            await tx.query('SELECT 2');
          },
          { timeoutMs: 5 },
        ),
        { code: 'PGCLEAR_TIMEOUT', outcome: 'not-sent' },
      );
      assert.equal((await prior).rows[0]!.n, 1);
      assert.equal(client.transactionStatus, 'idle');
      assert.equal(
        await client.transaction(async (tx) => (await tx.query('SELECT 3 AS n')).rows[0]!.n),
        3,
      );
    } finally {
      await client.close();
    }
  },
);
