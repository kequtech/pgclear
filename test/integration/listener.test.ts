import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { getEventListeners } from 'node:events';
import { listen, type ListenerStatus, type Notification, type Listener } from '../../src/index.js';
import { databaseUrl, ownedName, testConnection } from '../helpers/database.js';

const within = { timeout: 10000 };
async function until(check: () => boolean) {
  const end = performance.now() + 3000;
  while (!check()) {
    assert.ok(performance.now() < end, 'Listener did not reach the expected state.');
    await pause(5);
  }
}

test(
  'LISTEN preserves quoted channel names, Unicode payloads, sender PID and commit boundaries',
  within,
  async () => {
    const { client } = await testConnection();
    const channels = [ownedName() + '";SELECT 1;--', '\ufeff' + ownedName()];
    const messages: Notification[] = [];
    const statuses: ListenerStatus[] = [];
    const input = [...channels, channels[0]!];
    const listener = await listen(databaseUrl(), {
      channels: input,
      onNotification(value) {
        messages.push(value);
      },
      onStatus(value) {
        statuses.push(value);
      },
    });
    input.push('later mutation');
    try {
      assert.equal(listener.status.state, 'connected');
      assert.equal(statuses.length, 1);
      assert.ok(Object.isFrozen(listener.status));
      await client.queryClassic('BEGIN', []);
      await client.queryClassic('SELECT pg_notify($1,$2)', [channels[0]!, '\ufeffé{}']);
      await pause(25);
      assert.equal(messages.length, 0);
      await client.queryClassic('COMMIT', []);
      await client.queryClassic('SELECT pg_notify($1,$2)', [channels[1]!, '']);
      await until(() => messages.length === 2);
      assert.deepEqual(
        messages,
        channels.map((channel, i) => ({
          channel,
          payload: i === 0 ? '\ufeffé{}' : '',
          backendPid: client.info.backendPid,
        })),
      );
      assert.ok(messages.every(Object.isFrozen));
      await client.queryClassic('BEGIN', []);
      await client.queryClassic('SELECT pg_notify($1,$2)', [channels[0]!, 'rolled back']);
      await client.queryClassic('ROLLBACK', []);
      await client.queryClassic('SELECT pg_notify($1,$2)', [channels[0]!, 'barrier']);
      await until(() => messages.length === 3);
      assert.equal(messages[2]!.payload, 'barrier');
      const closing = listener.close();
      assert.equal(listener.close(), closing);
      assert.equal(listener.status.state, 'closed');
      await closing;
      await client.queryClassic('SELECT pg_notify($1,$2)', [channels[0]!, 'after close']);
      await pause(30);
      assert.equal(messages.length, 3);
    } finally {
      await listener.close();
      await client.close();
    }
  },
);

test(
  'channel identifiers reject empty, invalid and overlength byte strings without leaked sessions',
  within,
  async () => {
    for (const channels of [[''], ['a\0b'], ['\ud800'], ['é'.repeat(32)], ['a'.repeat(64)]])
      await assert.rejects(listen(databaseUrl(), { channels, onNotification() {} }), {
        code: 'PGCLEAR_CONFIGURATION',
      });
    const listener = await listen(databaseUrl(), {
      channels: ['é'.repeat(31) + 'a'],
      onNotification() {},
    });
    await listener.close();
  },
);

test(
  'reconnect reports a gap, replaces the generation and re-registers every channel',
  within,
  async () => {
    const { client } = await testConnection();
    const channels = [ownedName(), ownedName()];
    const statuses: ListenerStatus[] = [];
    const messages: Notification[] = [];
    const listener = await listen(databaseUrl(), {
      channels,
      reconnect: true,
      onStatus(status) {
        statuses.push(status);
      },
      onNotification(value) {
        messages.push(value);
      },
    });
    try {
      assert.equal(listener.status.state, 'connected');
      if (listener.status.state !== 'connected') assert.fail();
      const first = listener.status.session;
      // This PID came from this test's own dedicated listener.
      await client.queryClassic('SELECT pg_terminate_backend($1)', [first.backendPid]);
      await until(() => listener.status.state === 'connected' && listener.status.generation === 2);
      assert.equal(listener.status.state, 'connected');
      if (listener.status.state !== 'connected') assert.fail();
      assert.notEqual(listener.status.session.id, first.id);
      assert.notEqual(listener.status.session.backendPid, first.backendPid);
      assert.deepEqual(
        statuses.map((status) => status.state),
        ['connected', 'disconnected', 'reconnecting', 'connected'],
      );
      for (const channel of channels)
        await client.queryClassic('SELECT pg_notify($1,$2)', [channel, 'restored']);
      await until(() => messages.length === 2);
      assert.deepEqual(
        messages.map((value) => value.channel),
        channels,
      );
    } finally {
      await listener.close();
      await client.close();
    }
  },
);

test(
  'without reconnect, backend loss closes the handle and lifetime abort removes listeners',
  within,
  async () => {
    const { client } = await testConnection();
    const controller = new AbortController();
    const statuses: ListenerStatus[] = [];
    const listener = await listen(databaseUrl(), {
      channels: [ownedName()],
      signal: controller.signal,
      onNotification() {},
      onStatus(value) {
        statuses.push(value);
      },
    });
    let other: Listener | undefined;
    try {
      if (listener.status.state !== 'connected') assert.fail();
      await client.queryClassic('SELECT pg_terminate_backend($1)', [
        listener.status.session.backendPid,
      ]);
      await until(() => listener.status.state === 'closed');
      await listener.close();
      assert.deepEqual(
        statuses.map((value) => value.state),
        ['connected', 'disconnected', 'closed'],
      );
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      const abort = new AbortController();
      other = await listen(databaseUrl(), {
        channels: [ownedName()],
        signal: abort.signal,
        onNotification() {},
      });
      abort.abort();
      assert.equal(other.status.state, 'closed');
      await other.close();
      assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
    } finally {
      await other?.close();
      await listener.close();
      await client.close();
    }
  },
);

test(
  'dynamic membership on one connection acknowledges removal, empty membership and later resubscribe',
  within,
  async () => {
    const { client } = await testConnection();
    const first = ownedName() + '";--',
      second = 'é' + ownedName();
    const messages: Notification[] = [];
    const listener = await listen(databaseUrl(), {
      channels: [],
      onNotification(value) {
        messages.push(value);
      },
    });
    try {
      if (listener.status.state !== 'connected') assert.fail();
      const session = listener.status.session;
      await listener.subscribe(first);
      await listener.subscribe(first);
      await client.queryClassic('SELECT pg_notify($1,$2)', [first, 'first']);
      await until(() => messages.length === 1);
      await listener.unsubscribe(first);
      await listener.unsubscribe(first);
      await listener.subscribe(second);
      await client.queryClassic('SELECT pg_notify($1,$2)', [first, 'removed']);
      await client.queryClassic('SELECT pg_notify($1,$2)', [second, 'second']);
      await until(() => messages.length === 2);
      await listener.unsubscribe(second);
      await listener.subscribe(first);
      await client.queryClassic('SELECT pg_notify($1,$2)', [second, 'removed']);
      await client.queryClassic('SELECT pg_notify($1,$2)', [first, 'resubscribed']);
      await until(() => messages.length === 3);
      assert.deepEqual(
        messages.map(({ channel, payload }) => ({ channel, payload })),
        [
          { channel: first, payload: 'first' },
          { channel: second, payload: 'second' },
          { channel: first, payload: 'resubscribed' },
        ],
      );
      assert.equal(listener.status.state, 'connected');
      if (listener.status.state !== 'connected') assert.fail();
      assert.deepEqual(listener.status.session, session);
      assert.equal(listener.status.generation, 1);
      for (const method of ['subscribe', 'unsubscribe'] as const)
        await assert.rejects(listener[method]('é'.repeat(32)), { code: 'PGCLEAR_CONFIGURATION' });
      await listener.subscribe(second);
    } finally {
      await listener.close();
      await client.close();
    }
  },
);

test(
  'changes queued during reconnect settle after acknowledgement and survive the next reconnect',
  within,
  async () => {
    const { client } = await testConnection();
    const first = ownedName(),
      second = ownedName(),
      added = ownedName();
    const messages: Notification[] = [];
    const changes: Promise<void>[] = [];
    const queued = Promise.withResolvers<void>();
    const listener = await listen(databaseUrl(), {
      channels: [first, second],
      reconnect: true,
      onNotification(message) {
        messages.push(message);
      },
      onStatus(status) {
        if (status.state === 'reconnecting' && status.generation === 1) {
          changes.push(listener.unsubscribe(first), listener.subscribe(added));
          queued.resolve();
        }
      },
    });
    try {
      if (listener.status.state !== 'connected') assert.fail();
      await client.queryClassic('SELECT pg_terminate_backend($1)', [
        listener.status.session.backendPid,
      ]);
      await queued.promise;
      await Promise.all(changes);
      assert.equal(listener.status.state, 'connected');
      assert.equal(listener.status.generation, 2);
      if (listener.status.state !== 'connected') assert.fail();
      await client.queryClassic('SELECT pg_terminate_backend($1)', [
        listener.status.session.backendPid,
      ]);
      await until(() => listener.status.state === 'connected' && listener.status.generation === 3);
      for (const channel of [first, second, added])
        await client.queryClassic('SELECT pg_notify($1,$2)', [channel, 'restored']);
      await until(() => messages.length === 2);
      assert.deepEqual(
        messages.map((message) => message.channel),
        [second, added],
      );
    } finally {
      await listener.close();
      await client.close();
    }
  },
);
