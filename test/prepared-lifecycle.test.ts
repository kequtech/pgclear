import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runLifecycle } from './helpers/subprocess.js';
import { getEventListeners } from 'node:events';
import { connect, createPool } from '../src/index.js';
import { Reader } from '../src/protocol/messages.js';
import {
  sessionServer,
  fakeServer,
  packet,
  ready,
  startupReady,
  z,
  type Peer,
} from './helpers/server.js';

const within = { timeout: 5000 };
const metadata = Buffer.concat([packet('1'), packet('t', Buffer.from([0, 0])), packet('n')]);
const closeResponse = Buffer.concat([packet('3'), ready]);
const errorResponse = packet(
  'E',
  Buffer.concat([
    Buffer.from('S'),
    z('ERROR'),
    Buffer.from('C'),
    z('XX000'),
    Buffer.from('M'),
    z('fixture failure'),
    Buffer.from([0]),
  ]),
);
async function preparation(peer: Peer): Promise<string> {
  const parse = await peer.message();
  assert.equal(parse.type, 'P');
  const reader = new Reader(parse.payload);
  const name = reader.cstring();
  assert.match(name, /^pgclear_statement_\d+$/);
  assert.equal(reader.cstring(), 'SELECT 1');
  assert.equal(reader.uint16(), 0);
  reader.end();
  const describe = await peer.message();
  assert.equal(describe.type, 'D');
  assert.deepEqual(describe.payload, Buffer.concat([Buffer.from('S'), z(name)]));
  assert.equal((await peer.message()).type, 'S');
  return name;
}
async function closing(peer: Peer, name: string) {
  const close = await peer.message();
  assert.equal(close.type, 'C');
  assert.deepEqual(close.payload, Buffer.concat([Buffer.from('S'), z(name)]));
  assert.equal((await peer.message()).type, 'S');
}

test(
  'preparation waits for ReadyForQuery and execution binds the confirmed name without Parse',
  within,
  async () => {
    const described = Promise.withResolvers<void>();
    const releaseReady = Promise.withResolvers<void>();
    const server = await fakeServer(async (peer) => {
      await peer.startup();
      peer.socket.write(startupReady);
      const name = await preparation(peer);
      peer.socket.write(metadata);
      described.resolve();
      await releaseReady.promise;
      peer.socket.write(ready);
      const bind = await peer.message();
      assert.equal(bind.type, 'B');
      const reader = new Reader(bind.payload);
      assert.equal(reader.cstring(), '');
      assert.equal(reader.cstring(), name);
      assert.equal(reader.uint16(), 0);
      assert.equal(reader.uint16(), 0);
      assert.equal(reader.uint16(), 0);
      reader.end();
      assert.equal((await peer.message()).type, 'D');
      assert.equal((await peer.message()).type, 'E');
      assert.equal((await peer.message()).type, 'S');
      peer.socket.write(
        Buffer.concat([packet('2'), packet('n'), packet('C', z('SELECT 1')), ready]),
      );
      await closing(peer, name);
      peer.socket.write(closeResponse);
      assert.equal((await peer.message()).type, 'X');
      peer.socket.end();
    });
    const client = await connect({ host: server.host, port: server.port });
    try {
      let settled = false;
      const pending = client.prepare('SELECT 1').then((value) => {
        settled = true;
        return value;
      });
      await described.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(settled, false);
      releaseReady.resolve();
      const prepared = await pending;
      assert.deepEqual(prepared.description, { parameterTypes: [], fields: [] });
      assert.equal((await prepared.query()).commandTag, 'SELECT 1');
      const close = prepared.close();
      assert.equal(prepared.close(), close);
      await assert.rejects(prepared.query(), { code: 'PGCLEAR_EXPIRED' });
      await close;
    } finally {
      releaseReady.resolve();
      await client.close();
      await server.close();
    }
  },
);

for (const boundary of ['submitted', 'parsed', 'parameters', 'described'] as const)
  test(
    `creation loss at ${boundary} never publishes a handle or strands queued work`,
    within,
    async () => {
      const responses = {
        submitted: Buffer.alloc(0),
        parsed: packet('1'),
        parameters: Buffer.concat([packet('1'), packet('t', Buffer.from([0, 0]))]),
        described: metadata,
      };
      const server = await fakeServer(async (peer) => {
        await peer.startup();
        peer.socket.write(startupReady);
        await preparation(peer);
        peer.socket.end(responses[boundary]);
      });
      const client = await connect({ host: server.host, port: server.port });
      try {
        await Promise.all([
          assert.rejects(client.prepare('SELECT 1'), {
            code: 'PGCLEAR_CONNECTION_LOST',
            outcome: boundary === 'described' ? 'confirmed' : 'unknown',
          }),
          assert.rejects(client.query('SELECT 2'), { code: 'PGCLEAR_CLOSED', outcome: 'not-sent' }),
        ]);
      } finally {
        await client.close();
        await server.close();
      }
    },
  );

test(
  'failed Describe after Parse disposes its possibly created name before rejecting',
  within,
  async () => {
    const server = await fakeServer(async (peer) => {
      await peer.startup();
      peer.socket.write(startupReady);
      const name = await preparation(peer);
      peer.socket.write(Buffer.concat([packet('1'), errorResponse, ready]));
      await closing(peer, name);
      peer.socket.write(closeResponse);
      const next = await preparation(peer);
      assert.notEqual(name, next);
      peer.socket.write(Buffer.concat([metadata, ready]));
      await closing(peer, next);
      peer.socket.write(closeResponse);
      assert.equal((await peer.message()).type, 'X');
      peer.socket.end();
    });
    const client = await connect({ host: server.host, port: server.port });
    try {
      await assert.rejects(client.prepare('SELECT 1'), { code: 'XX000' });
      const valid = await client.prepare('SELECT 1');
      await valid.close();
    } finally {
      await client.close();
      await server.close();
    }
  },
);

for (const response of [ready, Buffer.concat([packet('1'), packet('t', Buffer.from([0, 1]))])])
  test('malformed or premature preparation responses retire the connection', within, async () => {
    const server = await fakeServer(async (peer) => {
      await peer.startup();
      peer.socket.write(startupReady);
      await preparation(peer);
      peer.socket.write(response);
    });
    const client = await connect({ host: server.host, port: server.port });
    try {
      await Promise.all([
        assert.rejects(client.prepare('SELECT 1'), { code: 'PGCLEAR_PROTOCOL' }),
        assert.rejects(client.query('SELECT 2'), { code: 'PGCLEAR_CLOSED', outcome: 'not-sent' }),
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });

for (const failure of ['loss', 'error', 'malformed'] as const)
  test(`statement Close ${failure} prevents physical session reuse`, within, async () => {
    const closeSeen = Promise.withResolvers<void>();
    const fail = Promise.withResolvers<void>();
    const server = await fakeServer(async (peer) => {
      await peer.startup();
      peer.socket.write(startupReady);
      const name = await preparation(peer);
      peer.socket.write(Buffer.concat([metadata, ready]));
      await closing(peer, name);
      closeSeen.resolve();
      await fail.promise;
      if (failure === 'loss') peer.socket.end();
      else
        peer.socket.write(
          failure === 'error'
            ? Buffer.concat([errorResponse, ready])
            : Buffer.concat([packet('3', Buffer.from([0])), ready]),
        );
    });
    const pool = createPool({ host: server.host, port: server.port, maxConnections: 1 });
    try {
      const lease = await pool.acquire();
      const prepared = await lease.prepare('SELECT 1');
      const releasing = assert.rejects(lease.release());
      await closeSeen.promise;
      await assert.rejects(prepared.query(), { code: 'PGCLEAR_EXPIRED' });
      assert.equal(pool.stats.idle, 0);
      fail.resolve();
      await releasing;
      assert.equal(pool.stats.total, 0);
      await assert.rejects(prepared.close());
    } finally {
      fail.resolve();
      await pool.close();
      await server.close();
    }
  });

test(
  'queued preparation abort and deadline send no Parse or Close and remove listeners',
  within,
  async () => {
    const server = await fakeServer(async (peer) => {
      await peer.startup();
      peer.socket.write(startupReady);
      const first = await preparation(peer);
      await new Promise((resolve) => setTimeout(resolve, 40));
      peer.socket.write(Buffer.concat([metadata, ready]));
      await closing(peer, first);
      peer.socket.write(closeResponse);
      assert.equal((await peer.message()).type, 'X');
      peer.socket.end();
    });
    const client = await connect({ host: server.host, port: server.port });
    try {
      const first = client.prepare('SELECT 1');
      const controller = new AbortController();
      const aborted = assert.rejects(client.prepare('SELECT 1', { signal: controller.signal }), {
        code: 'PGCLEAR_ABORTED',
        outcome: 'not-sent',
      });
      controller.abort();
      const timeout = assert.rejects(client.prepare('SELECT 1', { timeoutMs: 1 }), {
        code: 'PGCLEAR_TIMEOUT',
        outcome: 'not-sent',
      });
      await Promise.all([aborted, timeout]);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      await (await first).close();
    } finally {
      await client.close();
      await server.close();
    }
  },
);

test('failed explicit Close rejects queued work before dispatch', within, async () => {
  const server = await fakeServer(async (peer) => {
    await peer.startup();
    peer.socket.write(startupReady);
    const name = await preparation(peer);
    peer.socket.write(Buffer.concat([metadata, ready]));
    await closing(peer, name);
    peer.socket.write(Buffer.concat([errorResponse, ready]));
    await assert.rejects(peer.message(), { message: 'Peer closed.' });
  });
  const client = await connect({ host: server.host, port: server.port });
  try {
    const prepared = await client.prepare('SELECT 1');
    await Promise.all([
      assert.rejects(prepared.close(), { code: 'XX000' }),
      assert.rejects(client.query('SELECT 2'), { code: 'PGCLEAR_CLOSED', outcome: 'not-sent' }),
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});

test(
  'preparation and Close release child-process timers/listeners on success, errors and interruption',
  { timeout: 15000 },
  async () => {
    for (const scenario of ['success', 'server-error', 'abort', 'timeout'] as const) {
      const server = await sessionServer(
        async (peer) => {
          const name = await preparation(peer);
          if (scenario === 'success') peer.socket.write(Buffer.concat([metadata, ready]));
          if (scenario === 'server-error')
            peer.socket.write(Buffer.concat([packet('1'), errorResponse, ready]));
          if (scenario === 'success' || scenario === 'server-error') {
            await closing(peer, name);
            peer.socket.write(closeResponse);
          }
          assert.equal((await peer.message()).type, 'X');
          peer.socket.end();
        },
        (primary) => {
          primary.socket.write(Buffer.concat([errorResponse, ready]));
        },
      );
      try {
        await runLifecycle('prepare', scenario, server.port);
        await server.firstClosed;
        assert.equal(server.connections, 0);
      } finally {
        await server.close();
      }
    }
  },
);
