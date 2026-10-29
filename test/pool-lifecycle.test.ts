import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runLifecycle } from './helpers/subprocess.js';
import { setTimeout as pause } from 'node:timers/promises';
import { connect, createPool, type CloseOptions } from '../src/index.js';
import { PhysicalConnection } from '../src/connection/index.js';
import {
  sessionServer,
  fakeServer,
  packet,
  startupReady,
  z,
  auth,
  type Peer,
} from './helpers/server.js';

async function extended(peer: Peer): Promise<void> {
  for (const type of ['P', 'B', 'D', 'E', 'S']) assert.equal((await peer.message()).type, type);
}
function command(tag: string, status = 'I', sync = true): Buffer {
  return Buffer.concat([
    packet('1'),
    packet('2'),
    packet('n'),
    packet('C', z(tag)),
    ...(sync ? [packet('Z', Buffer.from(status))] : []),
  ]);
}
const within = { timeout: 10000 };

test('incompatible SQL tags reject before pool connection acquisition', within, async () => {
  let attempts = 0;
  const server = await fakeServer(async (peer) => {
    attempts++;
    peer.socket.destroy();
  });
  const pool = createPool({ host: server.host, port: server.port, maxConnections: 1 });
  try {
    for (const statement of ['SELECT 1', ['SELECT 1', []], { text: 'SELECT 1', values: [] }]) {
      let result: ReturnType<typeof pool.query> | undefined;
      assert.doesNotThrow(() => {
        result = pool.query(statement as never);
      });
      await assert.rejects(result!, { code: 'PGCLEAR_ENCODE', outcome: 'not-sent' });
      assert.deepEqual(pool.stats, { total: 0, idle: 0, leased: 0, waiting: 0 });
    }
  } finally {
    await pool.close();
    await server.close();
  }
  assert.equal(attempts, 0);
});

test(
  'COMMIT loss is unknown, ROLLBACK tag fails, and a received COMMIT survives ReadyForQuery loss',
  within,
  async () => {
    for (const scenario of ['lost', 'rollback', 'known'] as const) {
      const server = await fakeServer(async (peer) => {
        await peer.startup();
        peer.socket.write(startupReady);
        await extended(peer);
        peer.socket.write(command('BEGIN', 'T'));
        await extended(peer);
        if (scenario === 'lost') peer.socket.destroy();
        else if (scenario === 'known') peer.socket.end(command('COMMIT', 'I', false));
        else {
          peer.socket.write(command('ROLLBACK'));
          await peer.message();
          peer.socket.end();
        }
      });
      try {
        const client = await connect({ host: server.host, port: server.port });
        try {
          const result = client.transaction(async () => 42);
          if (scenario === 'lost')
            await assert.rejects(result, { code: 'PGCLEAR_COMMIT_UNKNOWN', outcome: 'unknown' });
          else if (scenario === 'rollback')
            await assert.rejects(result, {
              code: 'PGCLEAR_TRANSACTION_STATE',
              outcome: 'confirmed',
            });
          else assert.equal(await result, 42);
        } finally {
          await client.close();
        }
      } finally {
        await server.close();
      }
    }
  },
);

test(
  'close during a password provider fences late credentials and settles every acquisition',
  within,
  async () => {
    const providerEntered = Promise.withResolvers<void>(),
      credentials = Promise.withResolvers<string>();
    const server = await fakeServer(async (peer) => {
      await peer.startup();
      peer.socket.write(auth(5, Buffer.from([1, 2, 3, 4])));
      await peer.message();
      assert.fail('Late provider wrote after close.');
    });
    const pool = createPool({
      host: server.host,
      port: server.port,
      maxConnections: 1,
      password: () => {
        providerEntered.resolve();
        return credentials.promise;
      },
    });
    try {
      const opening = assert.rejects(pool.acquire(), { code: 'PGCLEAR_CLOSED' });
      const waiting = assert.rejects(pool.acquire(), { code: 'PGCLEAR_CLOSED' });
      await providerEntered.promise;
      await pool.close();
      await Promise.all([opening, waiting]);
      credentials.resolve('late');
      await pause(20);
      assert.equal(server.connections, 0);
      assert.equal(pool.stats.total, 0);
    } finally {
      credentials.resolve('late');
      await pool.close();
      await server.close();
    }
  },
);

test(
  'canceling cold acquisition frees capacity after transport disposal without publishing late startup',
  within,
  async () => {
    let count = 0;
    const entered = Promise.withResolvers<void>(),
      credentials = Promise.withResolvers<string>();
    const server = await fakeServer(async (peer) => {
      await peer.startup();
      count++;
      if (count === 1) {
        peer.socket.write(auth(5, Buffer.from([1, 2, 3, 4])));
        await peer.message();
        assert.fail('Canceled authentication continued.');
      } else {
        peer.socket.write(startupReady);
        await peer.message();
        peer.socket.end();
      }
    });
    const pool = createPool({
      host: server.host,
      port: server.port,
      maxConnections: 1,
      password: () => {
        entered.resolve();
        return credentials.promise;
      },
    });
    try {
      const controller = new AbortController(),
        canceled = pool.acquire({ signal: controller.signal });
      const rejected = assert.rejects(canceled, { code: 'PGCLEAR_ABORTED', outcome: 'not-sent' });
      await entered.promise;
      controller.abort();
      await rejected;
      const next = await pool.acquire();
      assert.equal(count, 2);
      assert.equal(pool.stats.total, 1);
      await next.release();
      credentials.resolve('late');
      await pause(20);
      assert.equal(count, 2);
    } finally {
      credentials.resolve('late');
      await pool.close();
      await server.close();
    }
  },
);

test(
  'authentication failures settle reserved acquisitions and never consume capacity permanently',
  within,
  async () => {
    const server = await fakeServer(async (peer) => {
      await peer.startup();
      peer.socket.end(
        packet(
          'E',
          Buffer.concat([
            Buffer.from('S'),
            z('ERROR'),
            Buffer.from('C'),
            z('28P01'),
            Buffer.from('M'),
            z('fixture'),
            Buffer.from([0]),
          ]),
        ),
      );
    });
    const pool = createPool({ host: server.host, port: server.port, maxConnections: 1 });
    try {
      await Promise.all(
        Array.from({ length: 4 }, () => assert.rejects(pool.acquire(), { code: '28P01' })),
      );
      assert.equal(pool.stats.total, 0);
      assert.equal(pool.stats.waiting, 0);
    } finally {
      await pool.close();
      await server.close();
    }
  },
);

test(
  'pool shutdown attempts every resource and preserves disposal failures after forcing cleanup',
  within,
  async (t) => {
    const server = await fakeServer(async (peer) => {
      await peer.startup();
      peer.socket.write(startupReady);
      await peer.message();
      peer.socket.end();
    });
    const pool = createPool({ host: server.host, port: server.port, maxConnections: 2 });
    try {
      const [a, b] = await Promise.all([pool.acquire(), pool.acquire()]);
      const close = PhysicalConnection.prototype.close;
      let calls = 0;
      t.mock.method(
        PhysicalConnection.prototype,
        'close',
        function (this: PhysicalConnection, options: CloseOptions = {}) {
          calls++;
          if (calls === 1) return Promise.reject(Error('fixture disposal failure'));
          return close.call(this, options);
        },
      );
      await assert.rejects(pool.close(), (error) => {
        assert.ok(error instanceof AggregateError);
        assert.match(String(error.errors[0]), /fixture disposal/);
        return true;
      });
      assert.equal(calls, 2);
      assert.equal(pool.stats.total, 0);
      await assert.rejects(a.queryClassic('SELECT 1', []), { code: 'PGCLEAR_EXPIRED' });
      await assert.rejects(b.queryClassic('SELECT 1', []), { code: 'PGCLEAR_EXPIRED' });
      await pause(20);
      assert.equal(server.connections, 0);
    } finally {
      await pool.close().catch(() => {});
      await server.close();
    }
  },
);

test(
  'close and abort dispose TCP, TLS negotiation and post-auth startup without late publication',
  within,
  async () => {
    for (const scenario of ['tcp-close', 'ssl-abort', 'startup-close'] as const) {
      const entered = Promise.withResolvers<void>();
      const server = await fakeServer(async (peer) => {
        if (scenario === 'ssl-abort') {
          await peer.bytes(8);
          entered.resolve();
        } else {
          await peer.startup();
          entered.resolve();
          if (scenario === 'startup-close') peer.socket.write(auth(0));
        }
        await peer.message();
        assert.fail('Disposed startup sent later work.');
      });
      const controller = new AbortController(),
        pool = createPool({
          host: server.host,
          port: server.port,
          ...(scenario === 'ssl-abort' ? { tls: {} } : {}),
        });
      try {
        const opening = assert.rejects(pool.acquire({ signal: controller.signal }), {
          code: scenario === 'ssl-abort' ? 'PGCLEAR_ABORTED' : 'PGCLEAR_CLOSED',
        });
        if (scenario !== 'tcp-close') await entered.promise;
        if (scenario === 'ssl-abort') controller.abort();
        await pool.close();
        await opening;
        await pause(20);
        assert.equal(server.connections, 0);
        assert.equal(pool.stats.total, 0);
      } finally {
        await pool.close();
        await server.close();
      }
    }
  },
);

test(
  'completed pool callbacks and transactions dispose long deadlines and abort listeners',
  { timeout: 15000 },
  async () => {
    for (const kind of ['withSession', 'transaction'] as const)
      for (const fail of [false, true]) {
        const server = await sessionServer(async (peer) => {
          if (kind === 'transaction')
            for (const tag of ['BEGIN', fail ? 'ROLLBACK' : 'COMMIT']) {
              await extended(peer);
              peer.socket.write(command(tag, tag === 'BEGIN' ? 'T' : 'I'));
            }
          assert.equal((await peer.message()).type, 'X');
          peer.socket.end();
        });
        try {
          await runLifecycle('pool', `${kind}:${fail}`, server.port);
          await server.firstClosed;
          assert.equal(server.connections, 0);
        } finally {
          await server.close();
        }
      }
  },
);

test('invalid per-query registries allocate no connection and leave no long deadline', async () => {
  const server = await sessionServer(async () => {
    assert.fail('Invalid registry must reject before connecting.');
  });
  try {
    await runLifecycle('pool', 'invalid-codecs:false', server.port);
    assert.equal(server.connections, 0);
  } finally {
    await server.close();
  }
});

test(
  'a stalled rollback uses one cleanup deadline and preserves the callback error',
  { timeout: 10000 },
  async () => {
    const server = await fakeServer(async (peer) => {
      await peer.startup();
      peer.socket.write(startupReady);
      await extended(peer);
      peer.socket.write(command('BEGIN', 'T'));
      await extended(peer);
      await peer.message();
    });
    try {
      const client = await connect({ host: server.host, port: server.port });
      try {
        const start = performance.now();
        await assert.rejects(
          client.transaction(async () => {
            throw Error('fixture work failure');
          }),
          (error) => {
            assert.ok(error instanceof AggregateError);
            assert.match(String(error.errors[0]), /fixture work failure/);
            assert.equal(error.errors[1].code, 'PGCLEAR_CLOSED');
            return true;
          },
        );
        assert.ok(performance.now() - start < 7500, 'Rollback cleanup restarted the deadline.');
        await assert.rejects(client.queryClassic('SELECT 1', []), { code: 'PGCLEAR_CLOSED' });
      } finally {
        await client.close();
      }
    } finally {
      await server.close();
    }
  },
);
