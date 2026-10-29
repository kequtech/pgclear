import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, createHmac, pbkdf2Sync, X509Certificate } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from '../src/index.js';
import { Reader } from '../src/protocol/messages.js';
import {
  auth,
  fakeServer,
  fixturePath,
  packet,
  Peer,
  ready,
  startupReady,
  z,
} from './helpers/server.js';

const within = { timeout: 5000 };

test(
  'trust startup waits for ReadyForQuery, reports identity and closes its transport',
  within,
  async () => {
    const server = await fakeServer(async (peer) => {
      const startup = await peer.startup();
      assert.equal(startup.get('user'), 'postgres');
      assert.equal(startup.get('database'), 'pgclear_test');
      peer.socket.write(startupReady);
      assert.equal((await peer.message()).type, 'X');
      peer.socket.end();
    });
    try {
      const connection = await connect({
        host: server.host,
        port: server.port,
        user: 'postgres',
        database: 'pgclear_test',
      });
      assert.equal(connection.info.backendPid, 123);
      assert.equal(connection.transactionStatus, 'idle');
      assert.ok(Object.isFrozen(connection.info));
      const closing = connection.close();
      assert.equal(connection.close(), closing);
      await closing;
      await server.firstClosed;
      assert.equal(server.connections, 0);
      await assert.rejects(connection.queryClassic('SELECT 1', []), {
        code: 'PGCLEAR_CLOSED',
        outcome: 'not-sent',
      });
    } finally {
      await server.close();
    }
  },
);

test(
  'startup rejects readiness before authentication and malformed messages without leaking a socket',
  within,
  async () => {
    for (const response of [
      ready,
      Buffer.from('5200000003', 'hex'),
      auth(11, Buffer.from('r=unexpected')),
      Buffer.concat([auth(0), auth(0), ready]),
    ]) {
      const server = await fakeServer(async (peer) => {
        await peer.startup();
        peer.socket.write(response);
      });
      try {
        await assert.rejects(connect({ host: server.host, port: server.port }), (error) => {
          assert.ok(
            ['PGCLEAR_PROTOCOL', 'PGCLEAR_AUTHENTICATION'].includes(
              (error as { code: string }).code,
            ),
          );
          return true;
        });
        await server.firstClosed;
        assert.equal(server.connections, 0);
      } finally {
        await server.close();
      }
    }
  },
);

test('startup timeout and abort fence late password-provider results', within, async () => {
  for (const interrupt of ['timeout', 'abort'] as const) {
    const asked = Promise.withResolvers<void>(),
      password = Promise.withResolvers<string>();
    let writes = 0;
    const server = await fakeServer(async (peer) => {
      await peer.startup();
      peer.socket.write(auth(5, Buffer.from([1, 2, 3, 4])));
      try {
        await peer.message();
        writes++;
      } catch {
        /* Expected transport disposal. */
      }
    });
    try {
      const controller = new AbortController();
      const connecting = connect(
        {
          host: server.host,
          port: server.port,
          connectTimeoutMs: interrupt === 'timeout' ? 30 : 1000,
          password: () => {
            asked.resolve();
            return password.promise;
          },
        },
        { signal: controller.signal },
      );
      const rejection = assert.rejects(connecting, {
        code: interrupt === 'timeout' ? 'PGCLEAR_TIMEOUT' : 'PGCLEAR_ABORTED',
      });
      await asked.promise;
      if (interrupt === 'abort') controller.abort();
      await rejection;
      await server.firstClosed;
      password.resolve('late');
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(writes, 0);
      assert.equal(server.connections, 0);
    } finally {
      password.resolve('late');
      await server.close();
    }
  }
});

test(
  'TLS startup verifies trust and hostname, refuses downgrade, and supports encrypted password authentication',
  within,
  async () => {
    const ca = await readFile(fixturePath('server-cert.pem'), 'utf8');
    const wrongCa = await readFile(fixturePath('untrusted-cert.pem'), 'utf8');
    for (const tls of [{ ca }, { ca: wrongCa }, { ca, serverName: 'wrong.invalid' }]) {
      const server = await fakeServer(
        async (peer) => {
          await peer.startup();
          peer.socket.write(auth(3));
          const response = await peer.message();
          assert.equal(response.type, 'p');
          assert.equal(response.payload.toString(), 'test-password\0');
          peer.socket.write(startupReady);
          await peer.message();
          peer.socket.end();
        },
        { tls: true },
      );
      try {
        const connecting = connect({
          host: server.host,
          port: server.port,
          password: 'test-password',
          tls,
        });
        if ('serverName' in tls || tls.ca === wrongCa)
          await assert.rejects(connecting, { code: 'PGCLEAR_CONNECTION_LOST' });
        else await (await connecting).close();
        await server.firstClosed;
        assert.equal(server.connections, 0);
      } finally {
        await server.close();
      }
    }
    for (const response of ['N', 'Sgarbage']) {
      const server = await fakeServer(async (peer) => {
        await peer.bytes(8);
        peer.socket.write(response);
      });
      try {
        await assert.rejects(connect({ host: server.host, port: server.port, tls: {} }), {
          code: 'PGCLEAR_PROTOCOL',
        });
      } finally {
        await server.close();
      }
    }
  },
);

test(
  'Unix socket startup permits password authentication without TCP plaintext exposure',
  within,
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pgclear-unix-'));
    const server = await fakeServer(
      async (peer) => {
        await peer.startup();
        peer.socket.write(auth(3));
        assert.equal((await peer.message()).payload.toString(), 'local-password\0');
        peer.socket.write(startupReady);
        await peer.message();
        peer.socket.end();
      },
      { unixPath: join(directory, '.s.PGSQL.5432') },
    );
    try {
      const connection = await connect({ host: directory, password: 'local-password' });
      await connection.close();
    } finally {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

async function scramServer(peer: Peer, certificate: Buffer, corruptProof: boolean) {
  await peer.startup();
  peer.socket.write(
    auth(10, Buffer.concat([z('SCRAM-SHA-256-PLUS'), z('SCRAM-SHA-256'), Buffer.from([0])])),
  );
  const initial = new Reader((await peer.message()).payload);
  assert.equal(initial.cstring(), 'SCRAM-SHA-256-PLUS');
  const first = initial.text(initial.int32());
  initial.end();
  const bare = first.slice('p=tls-server-end-point,,'.length);
  assert.ok(first.startsWith('p=tls-server-end-point,,'));
  const nonce = bare.slice(bare.indexOf('r=') + 2) + '-server';
  const salt = Buffer.from('independent-salt');
  const challenge = `r=${nonce},s=${salt.toString('base64')},i=4096`;
  peer.socket.write(auth(11, Buffer.from(challenge)));
  const final = (await peer.message()).payload.toString();
  const withoutProof = final.slice(0, final.lastIndexOf(',p='));
  const binding = createHash('sha384').update(certificate).digest();
  assert.equal(
    withoutProof,
    `c=${Buffer.concat([Buffer.from('p=tls-server-end-point,,'), binding]).toString('base64')},r=${nonce}`,
  );
  const salted = pbkdf2Sync('test-password', salt, 4096, 32, 'sha256');
  const hmac = (key: Buffer, text: string) => createHmac('sha256', key).update(text).digest();
  const transcript = `${bare},${challenge},${withoutProof}`;
  const key = hmac(salted, 'Client Key');
  const signature = hmac(createHash('sha256').update(key).digest(), transcript);
  const proof = Buffer.from(key.map((byte, index) => byte ^ signature[index]!)).toString('base64');
  assert.equal(final, withoutProof + ',p=' + proof);
  const serverProof = hmac(hmac(salted, 'Server Key'), transcript);
  if (corruptProof) serverProof[0] = serverProof[0]! ^ 1;
  peer.socket.write(
    Buffer.concat([auth(12, Buffer.from('v=' + serverProof.toString('base64'))), startupReady]),
  );
  await peer.message();
  peer.socket.end();
}

test(
  'full TLS SCRAM-PLUS startup verifies the channel-bound transcript and server signature',
  within,
  async () => {
    const ca = await readFile(fixturePath('server-cert.pem'), 'utf8');
    const certificate = new X509Certificate(ca).raw;
    for (const corruptProof of [false, true]) {
      const server = await fakeServer((peer) => scramServer(peer, certificate, corruptProof), {
        tls: true,
      });
      try {
        const connecting = connect({
          host: server.host,
          port: server.port,
          password: 'test-password',
          tls: { ca, channelBinding: 'require' },
        });
        if (corruptProof) await assert.rejects(connecting, { code: 'PGCLEAR_AUTHENTICATION' });
        else await (await connecting).close();
        await server.firstClosed;
      } finally {
        await server.close();
      }
    }
  },
);

test(
  'required channel binding refuses trust authentication on an otherwise verified TLS channel',
  within,
  async () => {
    const ca = await readFile(fixturePath('server-cert.pem'), 'utf8');
    const server = await fakeServer(
      async (peer) => {
        await peer.startup();
        peer.socket.write(startupReady);
      },
      { tls: true },
    );
    try {
      await assert.rejects(
        connect({ host: server.host, port: server.port, tls: { ca, channelBinding: 'require' } }),
        { code: 'PGCLEAR_AUTHENTICATION' },
      );
    } finally {
      await server.close();
    }
  },
);

test(
  'malformed query responses fail the owning request and reject queued work without replay',
  within,
  async () => {
    const server = await fakeServer(async (peer) => {
      await peer.startup();
      peer.socket.write(startupReady);
      assert.equal((await peer.message()).type, 'P');
      peer.socket.write(packet('D', Buffer.from([0, 0]))); // No Parse/Bind/RowDescription.
    });
    try {
      const connection = await connect({ host: server.host, port: server.port });
      const outcomes = await Promise.allSettled([
        connection.queryClassic('SELECT 1', []),
        connection.queryClassic('SELECT 2', []),
      ]);
      assert.equal(outcomes[0]!.status, 'rejected');
      assert.equal(outcomes[1]!.status, 'rejected');
      if (outcomes[0]!.status === 'rejected')
        assert.equal(outcomes[0]!.reason.code, 'PGCLEAR_PROTOCOL');
      if (outcomes[1]!.status === 'rejected') assert.equal(outcomes[1]!.reason.outcome, 'not-sent');
      await connection.close();
    } finally {
      await server.close();
    }
  },
);

test(
  'startup has a bounded deadline even if the server never answers SSLRequest',
  within,
  async () => {
    const server = await fakeServer(async (peer) => {
      await peer.bytes(8);
      await peer.bytes(1);
    });
    try {
      await assert.rejects(
        connect({ host: server.host, port: server.port, tls: {}, connectTimeoutMs: 25 }),
        { code: 'PGCLEAR_TIMEOUT' },
      );
      await server.firstClosed;
      assert.equal(server.connections, 0);
    } finally {
      await server.close();
    }
  },
);
