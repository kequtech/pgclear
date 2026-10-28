import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getEventListeners } from 'node:events';
import { setTimeout as pause } from 'node:timers/promises';
import { listen, DriverError, type ListenerStatus } from '../src/index.js';
import {
  fakeServer,
  startupReady,
  auth,
  i32,
  packet,
  ready,
  z,
  type Peer,
} from './helpers/server.js';
import {
  listenerQuery,
  listenerReply,
  notification,
  registerListener,
} from './helpers/listener.js';
import { runLifecycle } from './helpers/subprocess.js';

const within = { timeout: 7000 };
async function until(check: () => boolean) {
  const end = performance.now() + 3000;
  while (!check()) {
    assert.ok(performance.now() < end, 'Listener lifecycle did not reach its barrier.');
    await pause(5);
  }
}

test('invalid listener options reject before transport creation', async () => {
  for (const options of [
    null,
    {},
    { channels: Array(2), onNotification() {} },
    { channels: ['ok'], onNotification: 1 },
    { channels: ['ok'], onNotification() {}, reconnect: 'yes' },
    { channels: ['ok'], onNotification() {}, onStatus: false },
    { channels: ['ok'], onNotification() {}, extra: true },
  ])
    await assert.rejects(listen({ port: 1 }, options as never), { code: 'PGCLEAR_CONFIGURATION' });
});

test(
  'initial readiness timeout and abort settle after disposal without leaving signal listeners',
  within,
  async () => {
    for (const mode of ['timeout', 'abort', 'already-aborted'] as const) {
      const waiting = Promise.withResolvers<void>();
      const server = await fakeServer(async (peer) => {
        await peer.startup();
        peer.socket.write(startupReady);
        await listenerQuery(peer);
        waiting.resolve();
        await peer.message();
      });
      const controller = new AbortController();
      if (mode === 'already-aborted') controller.abort();
      try {
        const pending = listen(
          { host: server.host, port: server.port },
          {
            channels: ['fixture'],
            signal: controller.signal,
            timeoutMs: mode === 'timeout' ? 25 : 3600000,
            onNotification() {},
          },
        );
        const rejected = assert.rejects(pending, {
          code: mode === 'timeout' ? 'PGCLEAR_TIMEOUT' : 'PGCLEAR_ABORTED',
        });
        if (mode === 'abort') {
          await waiting.promise;
          controller.abort();
        }
        await rejected;
        await until(() => server.connections === 0);
        assert.equal(server.connections, 0);
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      } finally {
        await server.close();
      }
    }
  },
);

test(
  'initial deadline ends at readiness; later reconnect refreshes credentials and retries failed registration',
  within,
  async () => {
    let connections = 0,
      passwords = 0,
      active: Peer | undefined,
      delivered = 0;
    const statuses: ListenerStatus[] = [];
    const server = await fakeServer(async (peer) => {
      const generation = ++connections;
      await peer.startup();
      peer.socket.write(auth(5, i32(123)));
      assert.equal((await peer.message()).type, 'p');
      peer.socket.write(startupReady);
      if (generation === 2) {
        await listenerQuery(peer);
        peer.socket.write(listenerReply());
        await listenerQuery(peer);
        peer.socket.write(
          Buffer.concat([
            packet('E', Buffer.concat([z('SERROR'), z('CXX000'), z('Mfixture'), Buffer.from([0])])),
            ready,
          ]),
        );
        await peer.message();
        return;
      }
      await registerListener(peer, ['fixture', 'second']);
      active = peer;
      const close = await peer.message();
      assert.equal(close.type, 'X');
      peer.socket.end();
    });
    const listener = await listen(
      {
        host: server.host,
        port: server.port,
        password() {
          passwords++;
          return 'fixture-password';
        },
      },
      {
        channels: ['fixture', 'second'],
        reconnect: true,
        timeoutMs: 100,
        onNotification() {
          delivered++;
        },
        onStatus(status) {
          statuses.push(status);
        },
      },
    );
    try {
      await pause(125);
      assert.equal(listener.status.state, 'connected');
      active!.socket.write(notification());
      await until(() => delivered === 1);
      active!.socket.destroy();
      await until(() => listener.status.state === 'connected' && listener.status.generation === 2);
      assert.equal(passwords, 3);
      assert.deepEqual(
        statuses.map((s) => s.state),
        ['connected', 'disconnected', 'reconnecting', 'disconnected', 'reconnecting', 'connected'],
      );
      active!.socket.write(notification('second'));
      await until(() => delivered === 2);
    } finally {
      await listener.close();
      await server.close();
    }
  },
);

test(
  'close during backoff prevents another connection and invalid close options leave delivery active',
  within,
  async () => {
    let connections = 0,
      active: Peer | undefined,
      delivered = 0;
    const server = await fakeServer(async (peer) => {
      connections++;
      await peer.startup();
      peer.socket.write(startupReady);
      await registerListener(peer);
      active = peer;
      await peer.message();
    });
    const reconnecting = Promise.withResolvers<void>();
    const listener = await listen(
      { host: server.host, port: server.port, password: 'private-password-fixture' },
      {
        channels: ['fixture'],
        reconnect: true,
        onNotification() {
          delivered++;
        },
        onStatus(status) {
          if (status.state === 'reconnecting') reconnecting.resolve();
        },
      },
    );
    try {
      assert.ok(!JSON.stringify(listener).includes('private-password-fixture'));
      await assert.rejects(listener.close({ timeoutMs: -1 }), { code: 'PGCLEAR_CONFIGURATION' });
      active!.socket.write(notification());
      await until(() => delivered === 1);
      active!.socket.destroy();
      await reconnecting.promise;
      const closing = listener.close({ timeoutMs: 0 });
      assert.equal(listener.status.state, 'closed');
      assert.equal(listener.close(), closing);
      await closing;
      await pause(125);
      assert.equal(connections, 1);
      await until(() => server.connections === 0);
      assert.equal(server.connections, 0);
    } finally {
      await listener.close();
      await server.close();
    }
  },
);

test(
  'close during reconnect authentication fences a late password result without waiting for user code',
  within,
  async () => {
    let connections = 0,
      primary: Peer | undefined;
    const waiting = Promise.withResolvers<void>(),
      password = Promise.withResolvers<string>();
    const server = await fakeServer(async (peer) => {
      connections++;
      await peer.startup();
      if (connections > 1) {
        peer.socket.write(auth(5, i32(123)));
        waiting.resolve();
        await peer.message();
        return;
      }
      peer.socket.write(startupReady);
      await registerListener(peer);
      primary = peer;
      await peer.message();
    });
    const listener = await listen(
      { host: server.host, port: server.port, password: () => password.promise },
      {
        channels: ['fixture'],
        reconnect: true,
        onNotification() {},
      },
    );
    try {
      primary!.socket.destroy();
      await waiting.promise;
      await listener.close({ timeoutMs: 0 });
      await until(() => server.connections === 0);
      assert.equal(server.connections, 0);
      password.resolve('late');
      await pause(100);
      assert.equal(connections, 2);
      await until(() => server.connections === 0);
      assert.equal(server.connections, 0);
    } finally {
      password.resolve('late');
      await listener.close();
      await server.close();
    }
  },
);

test(
  'abort from initial connected observation cannot publish a live late handle',
  within,
  async () => {
    const server = await fakeServer(async (peer) => {
      await peer.startup();
      peer.socket.write(startupReady);
      await registerListener(peer);
      assert.equal((await peer.message()).type, 'X');
      peer.socket.end();
    });
    const controller = new AbortController();
    try {
      await assert.rejects(
        listen(
          { host: server.host, port: server.port },
          {
            channels: ['fixture'],
            signal: controller.signal,
            onNotification() {},
            onStatus(status) {
              if (status.state === 'connected') controller.abort();
            },
          },
        ),
        { code: 'PGCLEAR_ABORTED' },
      );
      await until(() => server.connections === 0);
      assert.equal(server.connections, 0);
    } finally {
      await server.close();
    }
  },
);

test(
  'listener subprocesses exit after notification, abort and close during reconnect; callback failures stay isolated',
  within,
  async () => {
    for (const scenario of ['complete', 'abort', 'reconnect-close']) {
      const server = await fakeServer(async (peer) => {
        await peer.startup();
        peer.socket.write(startupReady);
        await registerListener(peer);
        if (scenario === 'reconnect-close') {
          peer.socket.destroy();
          return;
        }
        if (scenario === 'complete') peer.socket.write(notification());
        assert.equal((await peer.message()).type, 'X');
        peer.socket.end();
      });
      try {
        await runLifecycle('listener', scenario, server.port);
        await until(() => server.connections === 0);
        assert.equal(server.connections, 0);
      } finally {
        await server.close();
      }
    }
  },
);

test(
  'closing from a notification callback fences coalesced later notifications',
  within,
  async () => {
    let primary: Peer | undefined,
      calls = 0;
    const server = await fakeServer(async (peer) => {
      await peer.startup();
      peer.socket.write(startupReady);
      await registerListener(peer);
      primary = peer;
      await peer.message();
    });
    const closing = Promise.withResolvers<void>();
    const listener = await listen(
      { host: server.host, port: server.port },
      {
        channels: ['fixture'],
        onNotification() {
          calls++;
          void listener.close({ timeoutMs: 0 }).then(closing.resolve, closing.reject);
        },
      },
    );
    try {
      primary!.socket.write(Buffer.concat([notification(), notification()]));
      await closing.promise;
      await pause(25);
      assert.equal(calls, 1);
      assert.equal(listener.status.state, 'closed');
    } finally {
      await listener.close();
      await server.close();
    }
  },
);

test('malformed idle notification closes the listener with protocol evidence', within, async () => {
  let primary: Peer | undefined;
  const statuses: ListenerStatus[] = [];
  const server = await fakeServer(async (peer) => {
    await peer.startup();
    peer.socket.write(startupReady);
    await registerListener(peer);
    primary = peer;
    await peer.message();
  });
  const listener = await listen(
    { host: server.host, port: server.port },
    {
      channels: ['fixture'],
      onNotification() {
        assert.fail('Malformed notification delivered.');
      },
      onStatus(status) {
        statuses.push(status);
      },
    },
  );
  try {
    primary!.socket.write(
      packet('A', Buffer.concat([i32(42), z('fixture'), Buffer.from('unterminated')])),
    );
    await until(() => listener.status.state === 'closed');
    const failure = statuses.find((status) => status.state === 'disconnected');
    assert.ok(failure?.error instanceof DriverError);
    assert.equal(failure.error.code, 'PGCLEAR_PROTOCOL');
    await listener.close();
  } finally {
    await listener.close();
    await server.close();
  }
});
