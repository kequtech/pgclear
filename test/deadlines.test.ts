import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connect, createPool, defaultCodecs } from '../src/index.js';
import { Reader } from '../src/protocol/messages.js';
import {
  fakeServer,
  sessionServer,
  i32,
  packet,
  ready,
  startupReady,
  z,
} from './helpers/server.js';

test('elapsed queued deadlines prevent dispatch even while a decoder blocks timers', async () => {
  const requests: string[] = [];
  const server = await fakeServer(async (peer) => {
    const length = (await peer.bytes(4)).readUInt32BE();
    const startup = await peer.bytes(length - 4);
    if (startup.readUInt32BE() === 80877102) {
      peer.socket.end();
      return;
    }
    peer.socket.write(startupReady);
    for (;;) {
      const parse = await peer.message();
      if (parse.type === 'X') {
        peer.socket.end();
        return;
      }
      assert.equal(parse.type, 'P');
      const reader = new Reader(parse.payload);
      assert.equal(reader.cstring(), '');
      requests.push(reader.cstring());
      for (const type of ['B', 'D', 'E', 'S']) assert.equal((await peer.message()).type, type);
      const description = packet(
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
      peer.socket.write(
        Buffer.concat([
          packet('1'),
          packet('2'),
          description,
          packet('D', Buffer.concat([Buffer.from([0, 1]), i32(1), Buffer.from('1')])),
          packet('C', z('SELECT 1')),
          ready,
        ]),
      );
    }
  });
  let decoded = false;
  const codecs = defaultCodecs.with({
    oid: 23,
    text: {
      encode: String,
      decode(value: string) {
        if (!decoded) {
          decoded = true;
          const end = performance.now() + 80;
          while (performance.now() < end) {
            /* Deliberately block timer callbacks. */
          }
        }
        return Number(value);
      },
    },
  });
  const client = await connect({ host: server.host, port: server.port, codecs });
  try {
    const first = client.query('SELECT 1');
    const expired = assert.rejects(client.query('SELECT 2', { timeoutMs: 20 }), {
      code: 'PGCLEAR_TIMEOUT',
      outcome: 'not-sent',
    });
    const next = client.query('SELECT 3');
    await Promise.all([first, expired, next]);
    assert.deepEqual(requests, ['SELECT 1', 'SELECT 3']);
  } finally {
    await client.close();
    await server.close();
  }
});

test('elapsed acquisition deadlines prevent checkout even while a connect observer blocks timers', async () => {
  const server = await sessionServer(async (peer) => {
    assert.equal((await peer.message()).type, 'X');
    peer.socket.end();
  });
  const pool = createPool({
    host: server.host,
    port: server.port,
    maxConnections: 1,
    acquireTimeoutMs: 20,
    onEvent(event) {
      if (event.type !== 'connect') return;
      const end = performance.now() + 80;
      while (performance.now() < end) {
        /* Deliberately block timer callbacks. */
      }
    },
  });
  try {
    await assert.rejects(pool.acquire(), { code: 'PGCLEAR_TIMEOUT', outcome: 'not-sent' });
  } finally {
    await pool.close();
    await server.close();
  }
  assert.equal(pool.stats.total, 0);
});
