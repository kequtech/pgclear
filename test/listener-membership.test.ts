import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getEventListeners } from 'node:events';
import { setTimeout as pause } from 'node:timers/promises';
import { listen, type ListenerStatus, type Notification } from '../src/index.js';
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
    assert.ok(performance.now() < end, 'Membership did not reach its barrier.');
    await pause(5);
  }
}
async function validate(peer: Peer, tag = 'SELECT 0') {
  assert.match(await listenerQuery(peer), /max_identifier_length/);
  peer.socket.write(listenerReply(tag));
}
async function membership(peer: Peer, command: string) {
  await validate(peer);
  assert.equal(await listenerQuery(peer), command);
  peer.socket.write(listenerReply(command.startsWith('UNLISTEN') ? 'UNLISTEN' : 'LISTEN'));
}

test(
  'membership waits for acknowledgement, serializes concurrent calls, and uses set semantics',
  within,
  async () => {
    const first = 'first"; SELECT 1; --';
    const quoted = '"' + first.replaceAll('"', '""') + '"';
    const waiting = Promise.withResolvers<void>();
    const acknowledge = Promise.withResolvers<void>();
    const messages: Notification[] = [];
    let active: Peer | undefined;
    let connections = 0;
    const server = await fakeServer(async (peer) => {
      connections++;
      await peer.startup();
      peer.socket.write(startupReady);
      await registerListener(peer, []);
      active = peer;
      await validate(peer);
      assert.equal(await listenerQuery(peer), 'LISTEN ' + quoted);
      waiting.resolve();
      await acknowledge.promise;
      // A notification coalesced with LISTEN completion must not be dropped by local membership.
      peer.socket.write(Buffer.concat([listenerReply('LISTEN'), notification(first)]));
      await validate(peer); // Duplicate subscribe: no LISTEN.
      await membership(peer, 'UNLISTEN ' + quoted);
      await validate(peer); // Duplicate unsubscribe: no UNLISTEN.
      await membership(peer, 'LISTEN "second"');
      assert.equal((await peer.message()).type, 'X');
      peer.socket.end();
    });
    const listener = await listen(
      { host: server.host, port: server.port },
      {
        channels: [],
        onNotification(value) {
          messages.push(value);
        },
      },
    );
    try {
      const settled: number[] = [];
      const subscribe = listener.subscribe(first).then(() => {
        settled.push(1);
      });
      const duplicate = listener.subscribe(first).then(() => {
        settled.push(2);
      });
      const unsubscribe = listener.unsubscribe(first).then(() => {
        settled.push(3);
      });
      const absent = listener.unsubscribe(first).then(() => {
        settled.push(4);
      });
      const again = listener.subscribe('second').then(() => {
        settled.push(5);
      });
      await waiting.promise;
      assert.deepEqual(settled, []);
      acknowledge.resolve();
      await Promise.all([subscribe, duplicate, unsubscribe, absent, again]);
      assert.deepEqual(settled, [1, 2, 3, 4, 5]);
      active!.socket.write(Buffer.concat([notification(first), notification('second')]));
      await until(() => messages.length === 2);
      assert.deepEqual(
        messages.map((message) => message.channel),
        [first, 'second'],
      );
      assert.equal(connections, 1);
      assert.equal(listener.status.generation, 1);
      assert.equal(listener.status.state, 'connected');
    } finally {
      acknowledge.resolve();
      await listener.close();
      await server.close();
    }
  },
);

test(
  'invalid membership inputs and server-length failures preserve a usable listener',
  within,
  async () => {
    const server = await fakeServer(async (peer) => {
      await peer.startup();
      peer.socket.write(startupReady);
      await registerListener(peer, []);
      await validate(peer, 'SELECT 1');
      await validate(peer);
      assert.equal(await listenerQuery(peer), 'LISTEN "rejected"');
      peer.socket.write(
        Buffer.concat([
          packet('E', Buffer.concat([z('SERROR'), z('C42501'), z('Mfixture'), Buffer.from([0])])),
          ready,
        ]),
      );
      await membership(peer, 'LISTEN "valid"');
      assert.equal((await peer.message()).type, 'X');
      peer.socket.end();
    });
    const listener = await listen(
      { host: server.host, port: server.port },
      { channels: [], onNotification() {} },
    );
    try {
      for (const invalid of ['', 'a\0b', '\ud800', 1, null]) {
        await assert.rejects(listener.subscribe(invalid as string), {
          code: 'PGCLEAR_CONFIGURATION',
        });
        await assert.rejects(listener.unsubscribe(invalid as string), {
          code: 'PGCLEAR_CONFIGURATION',
        });
      }
      await assert.rejects(listener.subscribe('valid', { timeoutMs: -1 }), {
        code: 'PGCLEAR_CONFIGURATION',
      });
      await assert.rejects(listener.unsubscribe('valid', { extra: true } as never), {
        code: 'PGCLEAR_CONFIGURATION',
      });
      await assert.rejects(listener.subscribe('valid', { timeoutMs: 0 }), {
        code: 'PGCLEAR_TIMEOUT',
        outcome: 'not-sent',
      });
      const abort = AbortSignal.abort();
      await assert.rejects(listener.subscribe('valid', { signal: abort }), {
        code: 'PGCLEAR_ABORTED',
        outcome: 'not-sent',
      });
      await assert.rejects(listener.subscribe('é'.repeat(32)), { code: 'PGCLEAR_CONFIGURATION' });
      await assert.rejects(listener.subscribe('rejected'), { code: '42501' });
      await listener.subscribe('valid');
    } finally {
      await listener.close();
      await server.close();
    }
    await assert.rejects(listener.subscribe('valid'), { code: 'PGCLEAR_CLOSED' });
    await assert.rejects(listener.unsubscribe('valid'), { code: 'PGCLEAR_CLOSED' });
  },
);

test(
  'loss during a change retries in order and reconnect restores only acknowledged membership',
  within,
  async () => {
    let connections = 0,
      active: Peer | undefined;
    const retrying = Promise.withResolvers<void>();
    const statuses: ListenerStatus[] = [];
    const messages: Notification[] = [];
    const server = await fakeServer(async (peer) => {
      const number = ++connections;
      await peer.startup();
      peer.socket.write(startupReady);
      if (number === 1) {
        await registerListener(peer, ['old']);
        await validate(peer);
        assert.equal(await listenerQuery(peer), 'LISTEN "added"');
        peer.socket.destroy();
      } else if (number === 2) {
        await registerListener(peer, ['old']);
        await membership(peer, 'LISTEN "added"');
        await membership(peer, 'UNLISTEN "old"');
        await membership(peer, 'LISTEN "fresh"');
        await membership(peer, 'UNLISTEN "added"');
        active = peer;
        await peer.message();
      } else {
        assert.equal(number, 3);
        await registerListener(peer, ['fresh']);
        active = peer;
        assert.equal((await peer.message()).type, 'X');
        peer.socket.end();
      }
    });
    const listener = await listen(
      { host: server.host, port: server.port },
      {
        channels: ['old'],
        reconnect: true,
        onStatus(status) {
          statuses.push(status);
          if (status.state === 'reconnecting') retrying.resolve();
        },
        onNotification(message) {
          messages.push(message);
        },
      },
    );
    try {
      const add = listener.subscribe('added');
      await retrying.promise;
      const remove = listener.unsubscribe('old');
      const fresh = listener.subscribe('fresh');
      const unadd = listener.unsubscribe('added');
      await Promise.all([add, remove, fresh, unadd]);
      await until(() => active !== undefined);
      assert.equal(listener.status.generation, 2);
      active!.socket.destroy();
      await until(() => listener.status.state === 'connected' && listener.status.generation === 3);
      active!.socket.write(
        Buffer.concat([notification('old'), notification('added'), notification('fresh')]),
      );
      await until(() => messages.length === 1);
      assert.equal(messages[0]!.channel, 'fresh');
      assert.deepEqual(
        statuses.map((s) => s.state),
        [
          'connected',
          'disconnected',
          'reconnecting',
          'connected',
          'disconnected',
          'reconnecting',
          'connected',
        ],
      );
    } finally {
      await listener.close();
      await server.close();
    }
  },
);

test(
  'queued changes can expire during reconnect authentication and close rejects remaining work',
  within,
  async () => {
    let connections = 0,
      primary: Peer | undefined;
    const authenticating = Promise.withResolvers<void>();
    const password = Promise.withResolvers<string>();
    const server = await fakeServer(async (peer) => {
      await peer.startup();
      if (++connections === 1) {
        peer.socket.write(startupReady);
        await registerListener(peer, []);
        primary = peer;
        await peer.message();
      } else {
        peer.socket.write(auth(5, i32(123)));
        authenticating.resolve();
        await peer.message();
      }
    });
    const listener = await listen(
      { host: server.host, port: server.port, password: () => password.promise },
      {
        channels: [],
        reconnect: true,
        onNotification() {},
      },
    );
    const controller = new AbortController();
    try {
      primary!.socket.destroy();
      await authenticating.promise;
      const remaining = assert.rejects(listener.subscribe('later', { timeoutMs: 3600000 }), {
        code: 'PGCLEAR_CLOSED',
      });
      const aborted = assert.rejects(
        listener.unsubscribe('absent', { signal: controller.signal }),
        { code: 'PGCLEAR_ABORTED', outcome: 'not-sent' },
      );
      const expired = assert.rejects(listener.subscribe('timeout', { timeoutMs: 25 }), {
        code: 'PGCLEAR_TIMEOUT',
        outcome: 'not-sent',
      });
      controller.abort();
      await Promise.all([aborted, expired]);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      await listener.close({ timeoutMs: 0 });
      await remaining;
      password.resolve('late');
      await until(() => server.connections === 0);
      assert.equal(connections, 2);
    } finally {
      password.resolve('late');
      await listener.close();
      await server.close();
    }
  },
);

test(
  'active change cancellation retires transport and keeps acknowledged membership for reconnect',
  within,
  async () => {
    for (const mode of ['abort', 'timeout'] as const) {
      let connections = 0,
        active: Peer | undefined;
      const dispatched = Promise.withResolvers<void>();
      const controller = new AbortController();
      const messages: Notification[] = [];
      const server = await fakeServer(async (peer) => {
        const number = ++connections;
        await peer.startup();
        peer.socket.write(startupReady);
        await registerListener(peer, ['original']);
        if (number === 1) {
          await validate(peer);
          assert.equal(await listenerQuery(peer), 'LISTEN "cancelled"');
          dispatched.resolve();
          await peer.message();
        } else {
          assert.equal(number, 2);
          await membership(peer, 'LISTEN "queued"');
          active = peer;
          assert.equal((await peer.message()).type, 'X');
          peer.socket.end();
        }
      });
      const listener = await listen(
        { host: server.host, port: server.port },
        {
          channels: ['original'],
          reconnect: true,
          onNotification(message) {
            messages.push(message);
          },
        },
      );
      try {
        const changed = listener.subscribe('cancelled', {
          signal: controller.signal,
          timeoutMs: mode === 'timeout' ? 500 : 3600000,
        });
        const rejected = assert.rejects(changed, {
          code: mode === 'timeout' ? 'PGCLEAR_TIMEOUT' : 'PGCLEAR_ABORTED',
          outcome: 'unknown',
        });
        const queued = listener.subscribe('queued');
        await dispatched.promise;
        if (mode === 'abort') controller.abort();
        await rejected;
        await queued;
        await until(() => active !== undefined);
        active!.socket.write(
          Buffer.concat([
            notification('cancelled'),
            notification('original'),
            notification('queued'),
          ]),
        );
        await until(() => messages.length === 2);
        assert.deepEqual(
          messages.map((message) => message.channel),
          ['original', 'queued'],
        );
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
        assert.equal(listener.status.generation, 2);
      } finally {
        await listener.close();
        await server.close();
      }
    }
  },
);

test(
  'active and queued membership timers do not keep closed subprocesses alive',
  within,
  async () => {
    for (const scenario of ['membership-close', 'membership-abort', 'membership-timeout']) {
      const server = await fakeServer(async (peer) => {
        await peer.startup();
        peer.socket.write(startupReady);
        await registerListener(peer);
        await validate(peer);
        assert.equal(await listenerQuery(peer), 'LISTEN "pending"');
        peer.socket.write(notification());
        await peer.message();
      });
      try {
        await runLifecycle('listener', scenario, server.port);
        await until(() => server.connections === 0);
      } finally {
        await server.close();
      }
    }
  },
);
