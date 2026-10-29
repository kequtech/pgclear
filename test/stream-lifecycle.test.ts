import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runLifecycle } from './helpers/subprocess.js';
import { connect, createPool, param, type RowStream } from '../src/index.js';
import {
  extendedRequest,
  executePortal,
  closePortal,
  syncReady,
  fakeServer,
  sessionServer,
  i32,
  packet,
  ready,
  startupReady,
  z,
} from './helpers/server.js';

const within = { timeout: 5000 };
const fields = packet(
  'T',
  Buffer.concat([
    Buffer.from([0, 1]),
    z('n'),
    i32(0),
    Buffer.from([0, 0]),
    i32(23),
    Buffer.from([0, 4]),
    i32(-1),
    Buffer.from([0, 0]),
  ]),
);
const row = (n: number) =>
  packet('D', Buffer.concat([Buffer.from([0, 1]), i32(String(n).length), Buffer.from(String(n))]));
const initial = Buffer.concat([packet('1'), packet('2'), fields]);
const closeReady = Buffer.concat([packet('3'), ready]);
const dbError = packet(
  'E',
  Buffer.concat([
    Buffer.from('S'),
    z('ERROR'),
    Buffer.from('C'),
    z('XX000'),
    Buffer.from('M'),
    z('fixture error'),
    Buffer.from([0]),
  ]),
);
async function collect(stream: RowStream<unknown>) {
  const rows = [];
  for await (const row of stream) rows.push(row);
  return rows;
}

test(
  'portal batches request no additional rows until demand and await Sync/Ready before settlement',
  within,
  async () => {
    let executions = 0;
    const closeSeen = Promise.withResolvers<void>(),
      allowReady = Promise.withResolvers<void>();
    const server = await fakeServer(async (peer) => {
      await peer.startup();
      peer.socket.write(startupReady);
      await extendedRequest(peer, 2);
      executions++;
      peer.socket.write(Buffer.concat([initial, row(1), row(2), packet('s')]));
      await executePortal(peer, 2);
      executions++;
      peer.socket.write(Buffer.concat([row(3), packet('C', z('SELECT 1'))]));
      assert.equal((await peer.message()).type, 'S');
      closeSeen.resolve();
      await allowReady.promise;
      peer.socket.write(ready);
      assert.equal((await peer.message()).type, 'X');
      peer.socket.end();
    });
    const client = await connect({ host: server.host, port: server.port });
    try {
      const stream = client.stream('SELECT n', { batchSize: 2 });
      const iterator = stream[Symbol.asyncIterator]();
      assert.deepEqual(
        (await stream.fields).map((f) => f.name),
        ['n'],
      );
      assert.deepEqual(await iterator.next(), { done: false, value: { n: 1 } });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(executions, 1);
      assert.deepEqual(await iterator.next(), { done: false, value: { n: 2 } });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(executions, 1);
      assert.deepEqual(await iterator.next(), { done: false, value: { n: 3 } });
      await closeSeen.promise;
      let finished = false;
      void stream.completion.then(() => {
        finished = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(finished, false);
      await assert.rejects(client.queryClassic('SELECT 1', []), { code: 'PGCLEAR_BUSY' });
      allowReady.resolve();
      assert.deepEqual(await stream.completion, {
        status: 'complete',
        result: { command: 'SELECT', commandTag: 'SELECT 1', rowCount: 3 },
      });
      assert.deepEqual(await iterator.next(), { done: true, value: undefined });
    } finally {
      allowReady.resolve();
      await client.close();
      await server.close();
    }
  },
);

test(
  'Close before metadata discards one in-flight batch and rejects fields while preserving a closed completion',
  within,
  async () => {
    const release = Promise.withResolvers<void>();
    const server = await fakeServer(async (peer) => {
      await peer.startup();
      peer.socket.write(startupReady);
      await extendedRequest(peer, 2);
      await release.promise;
      peer.socket.write(Buffer.concat([initial, row(1), row(2), packet('s')]));
      await closePortal(peer);
      peer.socket.write(closeReady);
      assert.equal((await peer.message()).type, 'X');
      peer.socket.end();
    });
    const client = await connect({ host: server.host, port: server.port });
    try {
      const stream = client.stream('SELECT n', { batchSize: 2 });
      const closing = stream.close();
      await assert.rejects(stream.fields, { code: 'PGCLEAR_ABORTED' });
      release.resolve();
      await closing;
      assert.deepEqual(await stream.completion, { status: 'closed' });
      assert.deepEqual(await collect(stream), []);
    } finally {
      release.resolve();
      await client.close();
      await server.close();
    }
  },
);

for (const failure of [
  'before-parse',
  'rows',
  'suspended',
  'close',
  'ready',
  'excess-rows',
  'bad-suspended',
  'short-suspended',
] as const)
  test(`stream ${failure} failure settles its owner without replay`, within, async () => {
    const server = await fakeServer(async (peer) => {
      await peer.startup();
      peer.socket.write(startupReady);
      await extendedRequest(peer, 2);
      if (failure === 'before-parse') {
        peer.socket.end();
        return;
      }
      if (failure === 'rows') {
        peer.socket.end(Buffer.concat([initial, row(1)]));
        return;
      }
      if (failure === 'excess-rows') {
        peer.socket.write(Buffer.concat([initial, row(1), row(2), row(3), packet('s')]));
        return;
      }
      if (failure === 'short-suspended') {
        peer.socket.write(Buffer.concat([initial, row(1), packet('s')]));
        return;
      }
      if (failure === 'bad-suspended') {
        peer.socket.write(packet('s'));
        return;
      }
      if (failure === 'suspended') {
        peer.socket.end(Buffer.concat([initial, row(1), row(2), packet('s')]));
        return;
      }
      peer.socket.write(Buffer.concat([initial, row(1), row(2), packet('s')]));
      await closePortal(peer);
      peer.socket.end(failure === 'ready' ? packet('3') : Buffer.alloc(0));
    });
    const client = await connect({ host: server.host, port: server.port });
    try {
      const stream = client.stream('SELECT n', { batchSize: 2 });
      const code = ['excess-rows', 'bad-suspended', 'short-suspended'].includes(failure)
        ? 'PGCLEAR_PROTOCOL'
        : 'PGCLEAR_CONNECTION_LOST';
      if (failure === 'close' || failure === 'ready') {
        await stream[Symbol.asyncIterator]().next();
        await assert.rejects(stream.close(), { code });
      } else await assert.rejects(collect(stream), { code });
      await assert.rejects(stream.completion, { code });
      await assert.rejects(client.queryClassic('SELECT 1', []), { code: 'PGCLEAR_CLOSED' });
    } finally {
      await client.close();
      await server.close();
    }
  });

test('server stream errors settle after one Sync/Ready recovery', within, async () => {
  const server = await fakeServer(async (peer) => {
    await peer.startup();
    peer.socket.write(startupReady);
    await extendedRequest(peer, 2);
    peer.socket.write(Buffer.concat([packet('1'), dbError]));
    assert.equal((await peer.message()).type, 'S');
    peer.socket.write(ready);
    assert.equal((await peer.message()).type, 'X');
    peer.socket.end();
  });
  const client = await connect({ host: server.host, port: server.port });
  try {
    const stream = client.stream('SELECT n', { batchSize: 2 });
    await assert.rejects(stream.fields, { code: 'XX000' });
    await assert.rejects(collect(stream), { code: 'XX000' });
    await assert.rejects(stream.completion, { code: 'XX000' });
  } finally {
    await client.close();
    await server.close();
  }
});

test('portal disposal errors retire a lease before it can return to the pool', within, async () => {
  const server = await fakeServer(async (peer) => {
    await peer.startup();
    peer.socket.write(startupReady);
    await extendedRequest(peer, 2);
    peer.socket.write(Buffer.concat([initial, row(1), row(2), packet('s')]));
    await closePortal(peer);
    peer.socket.write(Buffer.concat([dbError, ready]));
  });
  const pool = createPool({ host: server.host, port: server.port, maxConnections: 1 });
  try {
    const lease = await pool.acquire();
    const stream = lease.stream('SELECT n', { batchSize: 2 });
    await stream[Symbol.asyncIterator]().next();
    await assert.rejects(stream.close(), { code: 'XX000' });
    await assert.rejects(stream.completion, { code: 'XX000' });
    await lease.release();
    assert.equal(pool.stats.total, 0);
  } finally {
    await pool.close();
    await server.close();
  }
});

test(
  'an encoder cannot enter competing operations before stream reservation or dispatch after its deadline',
  within,
  async () => {
    const server = await fakeServer(async (peer) => {
      await peer.startup();
      peer.socket.write(startupReady);
      // Both encodes fail locally, so only Terminate may reach the server.
      assert.equal((await peer.message()).type, 'X');
      peer.socket.end();
    });
    const client = await connect({ host: server.host, port: server.port });
    try {
      let nested: Promise<unknown> | undefined;
      const value = param('value', {
        oid: 25,
        text: {
          encode(value: string) {
            nested = assert.rejects(client.queryClassic('SELECT 1', []), { code: 'PGCLEAR_BUSY' });
            throw Error(value);
          },
          decode: String,
        },
      });
      const stream = client.stream(['SELECT $1', [value]]);
      await assert.rejects(stream.completion, { code: 'PGCLEAR_ENCODE', outcome: 'not-sent' });
      await nested;
      const slow = param('value', {
        oid: 25,
        text: {
          encode(value: string) {
            const end = performance.now() + 10;
            while (performance.now() < end) {}
            return value;
          },
          decode: String,
        },
      });
      const expired = client.stream(['SELECT $1', [slow]], { timeoutMs: 1 });
      await assert.rejects(expired.completion, { code: 'PGCLEAR_TIMEOUT', outcome: 'not-sent' });
    } finally {
      await client.close();
      await server.close();
    }
  },
);

test(
  'stream child processes exit and remove lifetime listeners after completion, close, errors, timeout and abort',
  { timeout: 15000 },
  async () => {
    for (const scenario of ['complete', 'close', 'error', 'timeout', 'abort'] as const) {
      const server = await sessionServer(
        async (peer) => {
          await extendedRequest(peer, 2);
          if (scenario === 'complete')
            peer.socket.write(Buffer.concat([initial, row(1), packet('C', z('SELECT 1'))]));
          if (scenario === 'close')
            peer.socket.write(Buffer.concat([initial, row(1), row(2), packet('s')]));
          if (scenario === 'error') peer.socket.write(dbError);
          if (scenario === 'error' || scenario === 'abort' || scenario === 'timeout') {
            assert.equal((await peer.message()).type, 'S');
            peer.socket.write(ready);
          }
          if (scenario === 'complete') await syncReady(peer);
          if (scenario === 'close') {
            await closePortal(peer);
            peer.socket.write(closeReady);
          }
          assert.equal((await peer.message()).type, 'X');
          peer.socket.end();
        },
        (primary) => {
          primary.socket.write(dbError);
        },
      );
      try {
        await runLifecycle('stream', scenario, server.port);
        await server.firstClosed;
        assert.equal(server.connections, 0);
      } finally {
        await server.close();
      }
    }
  },
);

test(
  'pool shutdown bounds a stalled portal Close and settles abandoned streams',
  within,
  async () => {
    const closing = Promise.withResolvers<void>();
    const server = await fakeServer(async (peer) => {
      await peer.startup();
      peer.socket.write(startupReady);
      await extendedRequest(peer, 2);
      peer.socket.write(Buffer.concat([initial, row(1), row(2), packet('s')]));
      await closePortal(peer);
      closing.resolve();
      await peer.message();
    });
    const pool = createPool({ host: server.host, port: server.port, maxConnections: 1 });
    try {
      const lease = await pool.acquire();
      const stream = lease.stream('SELECT n', { batchSize: 2 });
      await stream.fields;
      const failed = assert.rejects(stream.completion, { code: 'PGCLEAR_CLOSED' });
      const stopped = pool.close({ timeoutMs: 20 });
      await closing.promise;
      await stopped;
      await failed;
      assert.equal(pool.stats.total, 0);
      await assert.rejects(collect(stream), { code: 'PGCLEAR_CLOSED' });
    } finally {
      await pool.close();
      await server.close();
    }
  },
);
