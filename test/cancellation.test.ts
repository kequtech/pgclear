import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createPool, connect } from '../src/index.js';
import { cancel } from '../src/transport/cancel.js';
import { normalizeConfiguration } from '../src/config/index.js';
import { fakeServer, fixturePath, startupReady, type Peer } from './helpers/server.js';
const within = { timeout: 10000 };

async function request(peer: Peer): Promise<number> {
  const length = (await peer.bytes(4)).readUInt32BE(),
    body = await peer.bytes(length - 4);
  if (body.readUInt32BE() === 80877102) {
    assert.equal(length, 16);
    assert.equal(body.readUInt32BE(4), 123);
    assert.equal(body.readUInt32BE(8), 456);
    return 80877102;
  }
  assert.equal(body.readUInt32BE(), 196608);
  return 196608;
}

test(
  'cancellation uses a separate verified TLS transport with the recorded backend key',
  within,
  async () => {
    const ca = await readFile(fixturePath('server-cert.pem'), 'utf8');
    for (const valid of [true, false]) {
      const server = await fakeServer(
        async (peer) => {
          assert.equal(await request(peer), 80877102);
          peer.socket.end();
        },
        { tls: true },
      );
      try {
        const config = normalizeConfiguration({
          host: server.host,
          port: server.port,
          tls: { ca, serverName: valid ? 'localhost' : 'wrong.test' },
        });
        const task = cancel(config, 123, 456, new AbortController().signal);
        if (valid) await task;
        else await assert.rejects(task, { code: 'PGCLEAR_CONNECTION_LOST' });
        await server.firstClosed;
        assert.equal(server.connections, 0);
      } finally {
        await server.close();
      }
    }
  },
);

test(
  'forced close disposes a stalled cancellation transport and settles accepted work',
  within,
  async () => {
    const executing = Promise.withResolvers<void>(),
      canceling = Promise.withResolvers<void>();
    const server = await fakeServer(async (peer) => {
      if ((await request(peer)) === 80877102) {
        canceling.resolve();
        await peer.message();
        return;
      }
      peer.socket.write(startupReady);
      for (let i = 0; i < 5; i++) await peer.message();
      executing.resolve();
      await peer.message();
    });
    try {
      const client = await connect({ host: server.host, port: server.port }),
        controller = new AbortController();
      const work = assert.rejects(client.query('SELECT 1', { signal: controller.signal }), {
        code: 'PGCLEAR_ABORTED',
        outcome: 'unknown',
      });
      await executing.promise;
      controller.abort();
      await canceling.promise;
      await client.close({ timeoutMs: 0 });
      await work;
      const end = performance.now() + 1000;
      while (server.connections && performance.now() < end)
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(server.connections, 0);
    } finally {
      await server.close();
    }
  },
);

test(
  'cancellation cleanup failure preserves the interruption and still empties pool capacity',
  within,
  async () => {
    const executing = Promise.withResolvers<void>();
    const server = await fakeServer(async (peer) => {
      if ((await request(peer)) === 80877102) {
        peer.socket.end('unexpected');
        return;
      }
      peer.socket.write(startupReady);
      for (let i = 0; i < 5; i++) await peer.message();
      executing.resolve();
      await peer.message();
    });
    const pool = createPool({ host: server.host, port: server.port, maxConnections: 1 });
    try {
      const controller = new AbortController(),
        task = pool.query('SELECT 1', { signal: controller.signal });
      const rejected = assert.rejects(task, (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors[0].code, 'PGCLEAR_ABORTED');
        assert.ok(error.errors[1] instanceof AggregateError);
        return true;
      });
      await executing.promise;
      controller.abort();
      await rejected;
      assert.equal(pool.stats.total, 0);
    } finally {
      await pool.close();
      await server.close();
    }
  },
);
