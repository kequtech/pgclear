import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runLifecycle } from './helpers/subprocess.js';
import { sessionServer, i32, packet, ready, z } from './helpers/server.js';

test(
  'Describe exits child processes after success, server failure, timeout and abort',
  { timeout: 15000 },
  async () => {
    for (const scenario of ['success', 'server-error', 'timeout', 'abort'] as const) {
      const server = await sessionServer(async (peer) => {
        assert.equal((await peer.message()).type, 'P');
        assert.equal((await peer.message()).type, 'D');
        assert.equal((await peer.message()).type, 'S');
        if (scenario === 'success')
          peer.socket.write(
            Buffer.concat([
              packet('1'),
              packet('t', Buffer.concat([Buffer.from([0, 1]), i32(23)])),
              packet('n'),
              ready,
            ]),
          );
        if (scenario === 'server-error')
          peer.socket.write(
            Buffer.concat([
              packet(
                'E',
                Buffer.concat([
                  Buffer.from('S'),
                  z('ERROR'),
                  Buffer.from('C'),
                  z('42601'),
                  Buffer.from('M'),
                  z('fixture syntax error'),
                  Buffer.from([0]),
                ]),
              ),
              ready,
            ]),
          );
        await peer.message();
        peer.socket.end();
      });
      try {
        await runLifecycle('describe', scenario, server.port);
        await server.firstClosed;
        assert.equal(server.connections, 0);
      } finally {
        await server.close();
      }
    }
  },
);

test(
  'Describe rejects malformed parameter metadata without stranding queued requests',
  { timeout: 5000 },
  async () => {
    const { connect } = await import('../src/index.js');
    const server = await sessionServer(async (peer) => {
      await peer.message();
      await peer.message();
      await peer.message();
      peer.socket.write(Buffer.concat([packet('1'), packet('t', Buffer.from([0, 1]))]));
    });
    try {
      const client = await connect({ host: server.host, port: server.port });
      await Promise.all([
        assert.rejects(client.describe('SELECT $1'), { code: 'PGCLEAR_PROTOCOL' }),
        assert.rejects(client.queryClassic('SELECT 1', []), {
          code: 'PGCLEAR_CLOSED',
          outcome: 'not-sent',
        }),
      ]);
      await client.close();
    } finally {
      await server.close();
    }
  },
);
