import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { SharedListener } from '../examples/shared-listener.js';
import { fakeServer, startupReady, type Peer } from './helpers/server.js';
import {
  listenerQuery,
  listenerReply,
  registerListener,
  notification,
} from './helpers/listener.js';

const within = { timeout: 10000 };
async function until(check: () => boolean) {
  const end = performance.now() + 3000;
  while (!check()) {
    assert.ok(performance.now() < end, 'Example did not reach its barrier.');
    await pause(5);
  }
}
async function change(peer: Peer, command: string) {
  assert.match(await listenerQuery(peer), /max_identifier_length/);
  peer.socket.write(listenerReply());
  assert.equal(await listenerQuery(peer), command);
}

test(
  'shared consumer example shares readiness and orders final removal before replacement',
  within,
  async () => {
    const registering = Promise.withResolvers<void>(),
      registered = Promise.withResolvers<void>();
    const removing = Promise.withResolvers<void>(),
      removed = Promise.withResolvers<void>();
    let active: Peer | undefined,
      connections = 0,
      delivered = 0,
      gaps = 0;
    const server = await fakeServer(async (peer) => {
      connections++;
      await peer.startup();
      peer.socket.write(startupReady);
      await registerListener(peer, []);
      await change(peer, 'LISTEN "users"');
      registering.resolve();
      await registered.promise;
      peer.socket.write(listenerReply('LISTEN'));
      await change(peer, 'UNLISTEN "users"');
      removing.resolve();
      await removed.promise;
      peer.socket.write(listenerReply('UNLISTEN'));
      await change(peer, 'LISTEN "users"');
      peer.socket.write(listenerReply('LISTEN'));
      active = peer;
      assert.equal((await peer.message()).type, 'X');
      peer.socket.end();
    });
    const owner = new SharedListener({ host: server.host, port: server.port });
    const subscriber = {
      onNotification() {
        delivered++;
      },
      onDisconnect() {
        gaps++;
      },
    };
    const first = owner.subscribe('users', subscriber),
      second = owner.subscribe('users', subscriber);
    try {
      assert.equal(first.ready, second.ready);
      await registering.promise;
      await first.release();
      const leaving = second.release();
      assert.equal(second.release(), leaving);
      const replacement = owner.subscribe('users', subscriber);
      let ready = false;
      void replacement.ready.then(() => {
        ready = true;
      });
      registered.resolve();
      await first.ready;
      await removing.promise;
      assert.equal(ready, false);
      removed.resolve();
      await Promise.all([leaving, replacement.ready]);
      active!.socket.write(notification('users'));
      await until(() => delivered === 1);
      assert.equal(connections, 1);
      await owner.stop();
      await until(() => gaps === 1);
      await replacement.release();
    } finally {
      registered.resolve();
      removed.resolve();
      await owner.stop();
      await server.close();
    }
  },
);

test(
  'shared consumer example invalidates old setup before opening a replacement',
  within,
  async () => {
    const setup = Promise.withResolvers<void>();
    let connections = 0,
      gaps = 0,
      delivered = 0;
    const server = await fakeServer(async (peer) => {
      if (++connections === 1) {
        await peer.startup();
        setup.resolve();
        await peer.message();
        return;
      }
      await peer.startup();
      peer.socket.write(startupReady);
      await registerListener(peer, []);
      await change(peer, 'LISTEN "replacement"');
      peer.socket.write(listenerReply('LISTEN'));
      peer.socket.write(notification('replacement'));
      assert.equal((await peer.message()).type, 'X');
      peer.socket.end();
    });
    const owner = new SharedListener({ host: server.host, port: server.port });
    try {
      const old = owner.subscribe('old', {
        onNotification() {
          assert.fail('Stale generation delivered.');
        },
        onDisconnect() {
          gaps++;
        },
      });
      const rejected = assert.rejects(old.ready);
      await setup.promise;
      const stopping = owner.stop();
      assert.equal(owner.stop(), stopping);
      const replacement = owner.subscribe('replacement', {
        onNotification() {
          delivered++;
        },
        onDisconnect() {
          gaps++;
        },
      });
      await Promise.all([stopping, rejected, replacement.ready]);
      await until(() => delivered === 1);
      assert.equal(gaps, 1);
      assert.equal(connections, 2);
      await old.release();
      await owner.stop();
      await until(() => gaps === 2);
    } finally {
      await owner.stop();
      await server.close();
    }
  },
);

test(
  'shared consumer example stops a pending registration and reconciles after disconnect',
  within,
  async () => {
    let connections = 0,
      gaps = 0,
      delivered = 0,
      active: Peer | undefined;
    const registered = Promise.withResolvers<void>();
    const server = await fakeServer(async (peer) => {
      const number = ++connections;
      await peer.startup();
      peer.socket.write(startupReady);
      await registerListener(peer, []);
      await change(peer, number === 1 ? 'LISTEN "pending"' : 'LISTEN "fresh"');
      if (number === 1) {
        registered.resolve();
        await peer.message();
        return;
      }
      peer.socket.write(listenerReply('LISTEN'));
      active = peer;
      await peer.message();
    });
    const owner = new SharedListener({ host: server.host, port: server.port });
    const subscriber = {
      onNotification() {
        delivered++;
      },
      onDisconnect() {
        gaps++;
      },
    };
    try {
      const pending = owner.subscribe('pending', subscriber);
      const rejected = assert.rejects(pending.ready);
      await registered.promise;
      await owner.stop();
      await rejected;
      await until(() => gaps === 1);
      const replacement = owner.subscribe('fresh', subscriber);
      await replacement.ready;
      active!.socket.write(notification('fresh'));
      await until(() => delivered === 1);
      active!.socket.destroy();
      await until(() => gaps === 2);
      await owner.stop();
      assert.equal(gaps, 2);
      await pending.release();
      await replacement.release();
    } finally {
      await owner.stop();
      await server.close();
    }
  },
);

test(
  'shared consumer example preserves subscriber receivers and isolates async callback failures',
  within,
  async () => {
    const failure = new Error('consumer failure');
    const reports: unknown[] = [];
    const previous = console.error;
    console.error = (error: unknown) => {
      reports.push(error);
    };
    class Consumer {
      notifications = 0;
      disconnects = 0;
      constructor(readonly fail: boolean) {}
      async onNotification() {
        this.notifications++;
        if (this.fail) throw failure;
      }
      async onDisconnect() {
        this.disconnects++;
        if (this.fail) throw failure;
      }
    }
    const healthy = new Consumer(false),
      broken = new Consumer(true);
    const server = await fakeServer(async (peer) => {
      await peer.startup();
      peer.socket.write(startupReady);
      await registerListener(peer, []);
      await change(peer, 'LISTEN "users"');
      peer.socket.write(listenerReply('LISTEN'));
      peer.socket.write(notification('users'));
      assert.equal((await peer.message()).type, 'X');
      peer.socket.end();
    });
    const owner = new SharedListener({ host: server.host, port: server.port });
    try {
      await Promise.all([
        owner.subscribe('users', healthy).ready,
        owner.subscribe('users', broken).ready,
      ]);
      await until(
        () => healthy.notifications === 1 && broken.notifications === 1 && reports.length === 1,
      );
      assert.equal(reports[0], failure);
      await owner.stop();
      await until(
        () => healthy.disconnects === 1 && broken.disconnects === 1 && reports.length === 2,
      );
      assert.equal(reports[1], failure);
    } finally {
      await owner.stop();
      await server.close();
      console.error = previous;
    }
  },
);
