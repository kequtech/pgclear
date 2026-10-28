import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { listen, connect, createPool } from '../../src/index.js';
import { compatibilityServer } from './server.js';

let fixture: Awaited<ReturnType<typeof compatibilityServer>>;
before(async () => {
  fixture = await compatibilityServer();
});
after(async () => {
  await fixture?.close();
});
const within = { timeout: 15000 };

test(
  'native PostgreSQL verified TLS, SCRAM channel binding and Unix sockets support session workflows',
  within,
  async () => {
    for (const options of [
      fixture.direct,
      fixture.unix,
      { ...fixture.unix, tls: false as const },
    ]) {
      const client = await connect(options);
      try {
        assert.equal(
          (await client.query('SELECT current_database() AS name')).rows[0]!.name,
          'pgclear_test',
        );
        const prepared = await client.prepare('SELECT $1::integer AS n');
        assert.deepEqual((await prepared.query([42])).rows, [{ n: 42 }]);
        await prepared.close();
        await client.transaction(async (tx) => {
          const stream = tx.stream('SELECT generate_series(1,3) AS n', { batchSize: 2 });
          const rows = [];
          for await (const row of stream) rows.push(row.n);
          assert.deepEqual(rows, [1, 2, 3]);
        });
      } finally {
        await client.close();
      }
    }
    await assert.rejects(
      connect({
        ...fixture.direct,
        tls: { ...(fixture.direct.tls as object), serverName: 'wrong.invalid' },
      }),
      { code: 'PGCLEAR_CONNECTION_LOST' },
    );
  },
);

test(
  'session pooling retains prepared statements, COPY, cursor batches and notifications',
  within,
  async () => {
    const pool = createPool({ ...fixture.session, maxConnections: 2 });
    const message = Promise.withResolvers<{
      channel: string;
      payload: string;
      backendPid: number;
    }>();
    const listener = await listen(fixture.session, {
      channels: ['compat_channel'],
      onNotification: message.resolve,
    });
    try {
      await pool.withSession(async (session) => {
        await session.query('CREATE TEMP TABLE compat_copy (n integer)');
        async function* source() {
          yield Buffer.from('1\n2\n3\n');
        }
        assert.equal(
          (await session.copyFrom('COPY compat_copy FROM STDIN', source())).rowCount,
          3n,
        );
        const prepared = await session.prepare(
          'SELECT n FROM compat_copy WHERE n >= $1 ORDER BY n',
        );
        assert.deepEqual((await prepared.query([2])).rows, [{ n: 2 }, { n: 3 }]);
        await prepared.close();
        const rows = [];
        for await (const row of session.stream('SELECT n FROM compat_copy ORDER BY n', {
          batchSize: 1,
        }))
          rows.push(row.n);
        assert.deepEqual(rows, [1, 2, 3]);
        const chunks = [];
        for await (const chunk of session.copyTo('COPY compat_copy TO STDOUT')) chunks.push(chunk);
        assert.equal(Buffer.concat(chunks).toString(), '1\n2\n3\n');
        const pid = (await session.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
        await session.queryClassic('SELECT pg_notify($1,$2)', ['compat_channel', 'via proxy']);
        assert.deepEqual(await message.promise, {
          channel: 'compat_channel',
          payload: 'via proxy',
          backendPid: pid,
        });
      });
    } finally {
      await listener.close();
      await pool.close();
    }
  },
);

test(
  'transaction pooling supports unnamed queries, pins transactions, recovers savepoints and retires canceled clients',
  within,
  async () => {
    const pool = createPool({ ...fixture.transaction, maxConnections: 2 });
    try {
      assert.deepEqual((await pool.queryClassic('SELECT $1::integer AS n', [42])).rows, [
        { n: 42 },
      ]);
      const both = Promise.withResolvers<void>();
      let entered = 0;
      const pids = await Promise.all(
        [1, 2].map((n) =>
          pool.transaction(async (tx) => {
            const pid = (await tx.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
            if (++entered === 2) both.resolve();
            await both.promise;
            await tx.query('CREATE TEMP TABLE compat_tx (n integer) ON COMMIT DROP');
            await tx.queryClassic('INSERT INTO compat_tx VALUES($1)', [n]);
            await assert.rejects(
              tx.savepoint(async (child) => {
                await child.query('SELECT 1/0');
              }),
              { code: '22012' },
            );
            assert.deepEqual((await tx.query('SELECT n FROM compat_tx')).rows, [{ n }]);
            assert.equal((await tx.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid, pid);
            return pid;
          }),
        ),
      );
      assert.notEqual(pids[0], pids[1]);
      await assert.rejects(pool.query('SELECT pg_sleep(5)', { timeoutMs: 30 }), {
        code: 'PGCLEAR_TIMEOUT',
      });
      assert.deepEqual((await pool.query('SELECT 7 AS n')).rows, [{ n: 7 }]);
    } finally {
      await pool.close();
    }
  },
);
