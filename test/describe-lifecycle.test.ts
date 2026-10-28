import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type Peer, fakeServer, i32, packet, ready, startupReady, z } from './helpers/server.js';

const run = promisify(execFile);
test(
  'Describe exits child processes after success, server failure, timeout and abort',
  { timeout: 15000 },
  async () => {
    for (const scenario of ['success', 'server-error', 'timeout', 'abort'] as const) {
      let primary: Peer | undefined;
      const server = await fakeServer(async (peer) => {
        const length = (await peer.bytes(4)).readUInt32BE();
        const body = await peer.bytes(length - 4);
        if (body.readUInt32BE() === 80877102) {
          assert.equal(length, 16);
          assert.equal(body.readUInt32BE(4), 123);
          assert.equal(body.readUInt32BE(8), 456);
          peer.socket.end();
          primary!.socket.end();
          return;
        }
        assert.equal(body.readUInt32BE(), 196608);
        primary = peer;
        peer.socket.write(startupReady);
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
        const source = `
        import assert from 'node:assert/strict';
        import {getEventListeners} from 'node:events';
        import {connect} from ${JSON.stringify(pathToFileURL(resolve('dist/index.js')).href)};
        const client=await connect({host:'127.0.0.1',port:${server.port}});
        const controller=new AbortController();
        let abortTimer;
        try {
          if(${JSON.stringify(scenario)}==='abort') abortTimer=setTimeout(()=>controller.abort(),25);
          const operation=client.describe('BEGIN', {timeoutMs:${scenario === 'timeout' ? 25 : 3600000},signal:controller.signal});
          if(${JSON.stringify(scenario)}==='success') assert.deepEqual((await operation).parameterTypes,[23]);
          else await assert.rejects(operation,{code:${JSON.stringify(scenario === 'server-error' ? '42601' : scenario === 'timeout' ? 'PGCLEAR_TIMEOUT' : 'PGCLEAR_ABORTED')}});
          assert.equal(getEventListeners(controller.signal,'abort').length,0);
        } finally {clearTimeout(abortTimer);await client.close();}
      `;
        await run(process.execPath, ['--input-type=module', '-e', source], { timeout: 3000 });
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
    let primary: Peer | undefined;
    const server = await fakeServer(async (peer) => {
      const length = (await peer.bytes(4)).readUInt32BE();
      const body = await peer.bytes(length - 4);
      if (body.readUInt32BE() === 80877102) {
        assert.equal(length, 16);
        assert.equal(body.readUInt32BE(4), 123);
        assert.equal(body.readUInt32BE(8), 456);
        peer.socket.end();
        primary!.socket.end();
        return;
      }
      assert.equal(body.readUInt32BE(), 196608);
      primary = peer;
      peer.socket.write(startupReady);
      await peer.message();
      await peer.message();
      await peer.message();
      peer.socket.write(Buffer.concat([packet('1'), packet('t', Buffer.from([0, 1]))]));
    });
    try {
      const client = await connect({ host: server.host, port: server.port });
      await Promise.all([
        assert.rejects(client.describe('SELECT $1'), { code: 'PGCLEAR_PROTOCOL' }),
        assert.rejects(client.query('SELECT 1'), { code: 'PGCLEAR_CLOSED', outcome: 'not-sent' }),
      ]);
      await client.close();
    } finally {
      await server.close();
    }
  },
);
