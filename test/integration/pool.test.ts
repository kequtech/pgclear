import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';
import { test } from 'node:test';
import { createPool, type Lease, type Session } from '../../src/index.js';
import { databaseUrl, ownedName } from '../helpers/database.js';

const within = { timeout: 10000 };
const poolOptions = () => ({ connectionString: databaseUrl(), applicationName: ownedName() });
async function until(check: () => boolean): Promise<void> {
  const end = performance.now() + 3000;
  while (!check()) {
    if (performance.now() > end) assert.fail('State did not settle.');
    await pause(5);
  }
}

test(
  'pool validates eagerly, opens lazily and accounts concurrent cold acquisitions',
  within,
  async () => {
    assert.throws(() => createPool({ maxConnections: 0 }), { code: 'PGCLEAR_CONFIGURATION' });
    const pool = createPool({ ...poolOptions(), maxConnections: 2, maxWaiting: 1 });
    assert.deepEqual(pool.stats, { total: 0, idle: 0, leased: 0, waiting: 0 });
    const first = pool.acquire(),
      second = pool.acquire(),
      third = pool.acquire();
    try {
      const [a, b] = await Promise.all([first, second]);
      assert.notEqual(a.info.backendPid, b.info.backendPid);
      assert.deepEqual(pool.stats, { total: 2, idle: 0, leased: 2, waiting: 1 });
      await assert.rejects(pool.acquire(), { code: 'PGCLEAR_QUEUE_FULL' });
      await a.release();
      const c = await third;
      assert.equal(c.info.backendPid, a.info.backendPid);
      await assert.rejects(a.queryClassic('SELECT 1', []), {
        code: 'PGCLEAR_EXPIRED',
        outcome: 'not-sent',
      });
      await Promise.all([b.release(), c.release()]);
      assert.deepEqual(pool.stats, { total: 2, idle: 2, leased: 0, waiting: 0 });
    } finally {
      await pool.close();
    }
    assert.deepEqual(pool.stats, { total: 0, idle: 0, leased: 0, waiting: 0 });
  },
);

test('acquisition is FIFO and canceled waiters cannot take a later release', within, async () => {
  const pool = createPool({ ...poolOptions(), maxConnections: 1 });
  try {
    const held = await pool.acquire(),
      controller = new AbortController();
    const canceled = pool.acquire({ signal: controller.signal });
    const order: string[] = [];
    const a = pool.acquire().then((lease) => {
      order.push('a');
      return lease;
    });
    const b = pool.acquire().then((lease) => {
      order.push('b');
      return lease;
    });
    controller.abort();
    await assert.rejects(canceled, { code: 'PGCLEAR_ABORTED', outcome: 'not-sent' });
    await held.release();
    const next = await a;
    assert.deepEqual(order, ['a']);
    await next.release();
    const last = await b;
    assert.deepEqual(order, ['a', 'b']);
    await last.release();
    const lease = await pool.acquire();
    await assert.rejects(pool.acquire({ timeoutMs: 5 }), {
      code: 'PGCLEAR_TIMEOUT',
      outcome: 'not-sent',
    });
    await lease.release();
  } finally {
    await pool.close();
  }
});

test('release expires immediately and drains all accepted work before reuse', within, async () => {
  const pool = createPool({ ...poolOptions(), maxConnections: 1 });
  try {
    const lease = await pool.acquire(),
      pid = lease.info.backendPid;
    const a = lease.queryClassic('SELECT pg_sleep(0.025), 1 AS n', []);
    const b = lease.queryClassic('SELECT 2 AS n', []);
    const release = lease.release();
    assert.equal(lease.release(), release);
    await assert.rejects(lease.queryClassic('SELECT 3', []), { code: 'PGCLEAR_EXPIRED' });
    const acquisition = pool.acquire();
    assert.equal((await a).rows[0]!.n, 1);
    assert.equal((await b).rows[0]!.n, 2);
    await release;
    const next = await acquisition;
    assert.equal(next.info.backendPid, pid);
    await next.release();
  } finally {
    await pool.close();
  }
});

test(
  'session callbacks expire and callback failure discards intentional session state',
  within,
  async () => {
    const pool = createPool({ ...poolOptions(), maxConnections: 1 });
    let saved: Session | undefined,
      pid = 0;
    try {
      await assert.rejects(
        pool.withSession(async (session) => {
          saved = session;
          pid = session.info.backendPid;
          await session.queryClassic('CREATE TEMP TABLE callback_owned(n int)', []);
          throw Error('fixture');
        }),
        /fixture/,
      );
      await assert.rejects(saved!.queryClassic('SELECT 1', []), { code: 'PGCLEAR_EXPIRED' });
      const lease = await pool.acquire();
      assert.notEqual(lease.info.backendPid, pid);
      await lease.release();
      await assert.rejects(pool.queryClassic('SELECT * FROM callback_owned', []), {
        code: '42P01',
      });
      const result = await pool.withSession(async (session) =>
        session.script('SELECT 1 AS n; SELECT 2 AS n'),
      );
      assert.deepEqual(
        result.map((r) => r.rows),
        [[{ n: 1 }], [{ n: 2 }]],
      );
    } finally {
      await pool.close();
    }
  },
);

test(
  'one-off operations reject leaked transaction state and non-idle lease release discards',
  within,
  async () => {
    const pool = createPool({ ...poolOptions(), maxConnections: 1 });
    try {
      await assert.rejects(pool.queryClassic('BEGIN', []), {
        code: 'PGCLEAR_SESSION_STATE',
        outcome: 'confirmed',
      });
      const lease = await pool.acquire(),
        pid = lease.info.backendPid;
      await lease.queryClassic('BEGIN', []);
      await lease.release();
      const next = await pool.acquire();
      assert.notEqual(next.info.backendPid, pid);
      await next.release();
      assert.deepEqual((await pool.queryClassic('SELECT 4 AS n', [])).rows, [{ n: 4 }]);
      assert.deepEqual((await pool.describe('SELECT $1::integer')).parameterTypes, [23]);
    } finally {
      await pool.close();
    }
  },
);

test('idle timeout and lifetime retirement never interrupt an active lease', within, async () => {
  const pool = createPool({
    ...poolOptions(),
    maxConnections: 1,
    idleTimeoutMs: 10,
    maxLifetimeMs: 20,
  });
  try {
    const held = await pool.acquire(),
      pid = held.info.backendPid;
    await held.queryClassic('SELECT pg_sleep(0.03)', []);
    assert.equal(held.info.backendPid, pid);
    assert.equal(pool.stats.leased, 1);
    await held.release();
    assert.equal(pool.stats.total, 0);
    const next = await pool.acquire();
    assert.notEqual(next.info.backendPid, pid);
    await next.release();
    await until(() => pool.stats.total === 0);
  } finally {
    await pool.close();
  }
});

test(
  'pool close fences leases, rejects waiters and drains accepted operations',
  within,
  async () => {
    const pool = createPool({ ...poolOptions(), maxConnections: 1 });
    const lease = await pool.acquire(),
      pending = lease.queryClassic('SELECT pg_sleep(0.02), 1 AS n', []);
    const waiting = pool.acquire();
    const closing = pool.close();
    assert.equal(pool.close({ timeoutMs: 0 }), closing);
    await assert.rejects(waiting, { code: 'PGCLEAR_CLOSED' });
    await assert.rejects(lease.queryClassic('SELECT 2', []), { code: 'PGCLEAR_EXPIRED' });
    assert.equal((await pending).rows[0]!.n, 1);
    await closing;
    await assert.rejects(pool.acquire(), { code: 'PGCLEAR_CLOSED' });
    await pause(20);
    assert.deepEqual(pool.stats, { total: 0, idle: 0, leased: 0, waiting: 0 });
  },
);

test(
  'seeded checkout/release/cancel sequences preserve expiration and capacity',
  within,
  async () => {
    const pool = createPool({ ...poolOptions(), maxConnections: 3 });
    const held: Lease[] = [],
      old: Lease[] = [];
    let seed = 0x773ab;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    try {
      for (let step = 0; step < 70; step++) {
        const action = random() % 4;
        if ((action === 0 || held.length === 0) && held.length < 3) held.push(await pool.acquire());
        else if (action === 1 && held.length) {
          const lease = held.splice(random() % held.length, 1)[0]!;
          old.push(lease);
          await lease.release({ discard: random() % 3 === 0 });
        } else if (held.length === 3) {
          const controller = new AbortController(),
            waiting = pool.acquire({ signal: controller.signal });
          controller.abort();
          await assert.rejects(waiting, { code: 'PGCLEAR_ABORTED' });
        } else {
          const lease = held[random() % held.length]!;
          assert.equal(
            (await lease.queryClassic('SELECT pg_backend_pid() AS pid', [])).rows[0]!.pid,
            lease.info.backendPid,
          );
        }
        if (old.length)
          await assert.rejects(old[random() % old.length]!.queryClassic('SELECT 1', []), {
            code: 'PGCLEAR_EXPIRED',
          });
        assert.ok(pool.stats.total <= 3, `seed=0x773ab step=${step}`);
        assert.equal(pool.stats.leased, held.length, `seed=0x773ab step=${step}`);
      }
    } finally {
      await pool.close();
    }
    for (const lease of held)
      await assert.rejects(lease.queryClassic('SELECT 1', []), { code: 'PGCLEAR_EXPIRED' });
    assert.equal(pool.stats.total, 0);
  },
);

test(
  'a pool query deadline includes acquisition and an active cancellation cannot reach the next lease',
  within,
  async () => {
    const pool = createPool({ ...poolOptions(), maxConnections: 1 });
    try {
      const held = await pool.acquire(),
        oldPid = held.info.backendPid;
      const expired = assert.rejects(pool.queryClassic('SELECT 9 AS n', [], { timeoutMs: 5 }), {
        code: 'PGCLEAR_TIMEOUT',
        outcome: 'not-sent',
      });
      await expired;
      assert.equal((await held.queryClassic('SELECT 1 AS n', [])).rows[0]!.n, 1);
      await held.release();
      const controller = new AbortController();
      let activePid = 0;
      const entered = Promise.withResolvers<void>();
      const canceled = pool.withSession(async (session) => {
        activePid = session.info.backendPid;
        const query = session.queryClassic('SELECT pg_sleep(30)', [], {
          signal: controller.signal,
        });
        entered.resolve();
        await query;
      });
      const rejected = assert.rejects(canceled, { code: 'PGCLEAR_ABORTED' });
      await entered.promise;
      controller.abort();
      await rejected;
      const next = await pool.acquire();
      assert.equal(activePid, oldPid);
      assert.notEqual(next.info.backendPid, oldPid);
      assert.equal((await next.queryClassic('SELECT 7 AS n', [])).rows[0]!.n, 7);
      await next.release();
    } finally {
      await pool.close();
    }
  },
);
