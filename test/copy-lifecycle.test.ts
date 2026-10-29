import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runLifecycle } from './helpers/subprocess.js';
import { getEventListeners } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createPool, connect, type CopySource, type CopyStream } from '../src/index.js';
import {
  fakeServer,
  sessionServer,
  extendedRequest,
  syncReady,
  fixturePath,
  packet,
  ready,
  startupReady,
  z,
} from './helpers/server.js';
const within = { timeout: 10000 };
const begin = Buffer.concat([packet('1'), packet('2'), packet('n')]);
const response = (direction: 'in' | 'out') =>
  packet(direction === 'in' ? 'G' : 'H', Buffer.from([0, 0, 1, 0, 0]));
const error = (code = 'XX000') =>
  packet(
    'E',
    Buffer.concat([
      Buffer.from('S'),
      z('ERROR'),
      Buffer.from('C'),
      z(code),
      Buffer.from('M'),
      z('fixture error'),
      Buffer.from([0]),
    ]),
  );
async function* source(...parts: string[]) {
  for (const part of parts) yield Buffer.from(part);
}
async function consume(stream: CopyStream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test(
  'COPY FROM waits for acceptance, splits large chunks and sends CopyDone/Flush before Sync/Ready',
  within,
  async () => {
    let pulls = 0;
    const acknowledged = Promise.withResolvers<void>(),
      proceed = Promise.withResolvers<void>();
    const data = Buffer.alloc(180000, 97),
      sizes: number[] = [];
    const server = await fakeServer(async (peer) => {
      await peer.startup();
      peer.socket.write(startupReady);
      await extendedRequest(peer);
      acknowledged.resolve();
      await proceed.promise;
      assert.equal(pulls, 0);
      peer.socket.write(Buffer.concat([begin, response('in')]));
      let length = 0;
      for (;;) {
        const message = await peer.message();
        if (message.type === 'c') break;
        assert.equal(message.type, 'd');
        sizes.push(message.payload.length);
        assert.ok(message.payload.every((value) => value === 97));
        length += message.payload.length;
      }
      assert.equal(length, data.length);
      assert.equal((await peer.message()).type, 'H');
      peer.socket.write(packet('C', z('COPY 1')));
      await syncReady(peer);
      assert.equal((await peer.message()).type, 'X');
      peer.socket.end();
    });
    const client = await connect({ host: server.host, port: server.port });
    try {
      const input: CopySource = {
        async *[Symbol.asyncIterator]() {
          pulls++;
          yield data;
        },
      };
      const pending = client.copyFrom('COPY fixture FROM STDIN', input);
      await acknowledged.promise;
      assert.equal(pulls, 0);
      proceed.resolve();
      assert.deepEqual(await pending, { command: 'COPY', commandTag: 'COPY 1', rowCount: 1 });
      assert.deepEqual(sizes, [65536, 65536, 48928]);
      assert.equal(pulls, 1);
    } finally {
      proceed.resolve();
      await client.close();
      await server.close();
    }
  },
);

test(
  'COPY output gates coalesced frames on consumer demand and retains stable byte buffers',
  within,
  async () => {
    const server = await fakeServer(async (peer) => {
      await peer.startup();
      peer.socket.write(startupReady);
      await extendedRequest(peer);
      peer.socket.write(
        Buffer.concat([
          begin,
          response('out'),
          packet('d', Buffer.from('first')),
          packet('d', Buffer.from('second')),
          packet('c'),
          packet('C', z('COPY 2')),
        ]),
      );
      await syncReady(peer);
      assert.equal((await peer.message()).type, 'X');
      peer.socket.end();
    });
    const client = await connect({ host: server.host, port: server.port });
    try {
      const stream = client.copyTo('COPY fixture TO STDOUT'),
        iterator = stream[Symbol.asyncIterator]();
      const first = await iterator.next();
      assert.equal(Buffer.from(first.value!).toString(), 'first');
      let finished = false;
      void stream.completion.then(() => {
        finished = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 15));
      assert.equal(finished, false);
      const second = await iterator.next();
      assert.equal(Buffer.from(second.value!).toString(), 'second');
      assert.equal(Buffer.from(first.value!).toString(), 'first');
      assert.equal((await iterator.next()).done, true);
      assert.deepEqual(await stream.completion, {
        status: 'complete',
        result: { command: 'COPY', commandTag: 'COPY 2', rowCount: 2 },
      });
    } finally {
      await client.close();
      await server.close();
    }
  },
);

test(
  'source failure uses a fixed CopyFail message, returns the iterator and resynchronizes before reuse',
  within,
  async () => {
    let returned = 0;
    const server = await fakeServer(async (peer) => {
      await peer.startup();
      peer.socket.write(startupReady);
      await extendedRequest(peer);
      peer.socket.write(Buffer.concat([begin, response('in')]));
      const failure = await peer.message();
      assert.equal(failure.type, 'f');
      assert.equal(failure.payload.toString(), 'pgclear COPY source failed.\0');
      assert.equal((await peer.message()).type, 'S');
      peer.socket.write(Buffer.concat([error('57014'), ready]));
      assert.equal((await peer.message()).type, 'X');
      peer.socket.end();
    });
    const client = await connect({ host: server.host, port: server.port });
    try {
      const input: CopySource = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              throw Error('private source text');
            },
            async return() {
              returned++;
              return { done: true, value: undefined };
            },
          };
        },
      };
      await assert.rejects(client.copyFrom('COPY fixture FROM STDIN', input), {
        code: 'PGCLEAR_COPY_SOURCE',
        outcome: 'confirmed',
      });
      assert.equal(returned, 1);
    } finally {
      await client.close();
      await server.close();
    }
  },
);

test(
  'server errors interrupt a pending source pull and fence late data after disposal',
  within,
  async () => {
    const pulling = Promise.withResolvers<void>(),
      late = Promise.withResolvers<IteratorResult<Uint8Array>>();
    let returned = 0;
    const server = await fakeServer(async (peer) => {
      await peer.startup();
      peer.socket.write(startupReady);
      await extendedRequest(peer);
      peer.socket.write(Buffer.concat([begin, response('in')]));
      await pulling.promise;
      peer.socket.write(error());
      assert.equal((await peer.message()).type, 'S');
      peer.socket.write(ready);
      assert.equal((await peer.message()).type, 'X');
      peer.socket.end();
    });
    const client = await connect({ host: server.host, port: server.port });
    try {
      const input: CopySource = {
        [Symbol.asyncIterator]() {
          return {
            next() {
              pulling.resolve();
              return late.promise;
            },
            async return() {
              returned++;
              return { done: true, value: undefined };
            },
          };
        },
      };
      await assert.rejects(client.copyFrom('COPY fixture FROM STDIN', input), { code: 'XX000' });
      assert.equal(returned, 1);
      late.resolve({ done: false, value: Buffer.from('late') });
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      late.resolve({ done: true, value: undefined });
      await client.close();
      await server.close();
    }
  },
);

test(
  'source-return failures preserve the source error and retire the session',
  within,
  async () => {
    const server = await fakeServer(async (peer) => {
      await peer.startup();
      peer.socket.write(startupReady);
      await extendedRequest(peer);
      peer.socket.write(Buffer.concat([begin, response('in')]));
      assert.equal((await peer.message()).type, 'f');
      assert.equal((await peer.message()).type, 'S');
      peer.socket.write(Buffer.concat([error('57014'), ready]));
    });
    const client = await connect({ host: server.host, port: server.port });
    try {
      const input: CopySource = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              throw Error('primary');
            },
            async return() {
              throw Error('cleanup');
            },
          };
        },
      };
      await assert.rejects(client.copyFrom('COPY fixture FROM STDIN', input), (cause) => {
        assert.ok(cause instanceof AggregateError);
        assert.equal(cause.errors[0].code, 'PGCLEAR_COPY_SOURCE');
        assert.equal(cause.errors[1].message, 'cleanup');
        return true;
      });
      await assert.rejects(client.queryClassic('SELECT 1', []), { code: 'PGCLEAR_CLOSED' });
    } finally {
      await client.close();
      await server.close();
    }
  },
);

for (const fault of [
  'bad-format',
  'truncated-format',
  'bad-column',
  'data-before-response',
  'done-before-response',
  'command-before-done',
  'ready-before-command',
  'loss',
] as const)
  test(`COPY output ${fault} retires its session and settles iteration`, within, async () => {
    const server = await fakeServer(async (peer) => {
      await peer.startup();
      peer.socket.write(startupReady);
      await extendedRequest(peer);
      if (fault === 'loss') {
        peer.socket.end(Buffer.concat([begin, response('out'), packet('d', Buffer.from('bytes'))]));
        return;
      }
      const data = {
        'bad-format': Buffer.concat([begin, packet('H', Buffer.from([2, 0, 0]))]),
        'truncated-format': Buffer.concat([begin, packet('H', Buffer.from([0, 0, 1]))]),
        'bad-column': Buffer.concat([begin, packet('H', Buffer.from([0, 0, 1, 0, 2]))]),
        'data-before-response': Buffer.concat([begin, packet('d')]),
        'done-before-response': Buffer.concat([begin, packet('c')]),
        'command-before-done': Buffer.concat([begin, response('out'), packet('C', z('COPY 1'))]),
        'ready-before-command': Buffer.concat([begin, response('out'), ready]),
      }[fault];
      peer.socket.write(data);
    });
    const client = await connect({ host: server.host, port: server.port });
    try {
      const stream = client.copyTo('COPY fixture TO STDOUT');
      await assert.rejects(consume(stream), {
        code: fault === 'loss' ? 'PGCLEAR_CONNECTION_LOST' : 'PGCLEAR_PROTOCOL',
      });
      await assert.rejects(stream.completion);
    } finally {
      await client.close();
      await server.close();
    }
  });

test(
  'queued COPY output close is local and COPY input abort never pulls the source',
  within,
  async () => {
    const server = await fakeServer(async (peer) => {
      await peer.startup();
      peer.socket.write(startupReady);
      for (const type of ['P', 'B', 'D', 'E', 'S']) assert.equal((await peer.message()).type, type);
      await new Promise((resolve) => setTimeout(resolve, 30));
      peer.socket.write(
        Buffer.concat([packet('1'), packet('2'), packet('n'), packet('C', z('SELECT 0')), ready]),
      );
      assert.equal((await peer.message()).type, 'X');
      peer.socket.end();
    });
    const client = await connect({ host: server.host, port: server.port });
    try {
      const blocking = client.queryClassic('SELECT 0', []);
      const stream = client.copyTo('COPY fixture TO STDOUT');
      await stream.close();
      assert.deepEqual(await stream.completion, { status: 'closed' });
      const controller = new AbortController();
      let pulls = 0;
      const input: CopySource = {
        async *[Symbol.asyncIterator]() {
          pulls++;
          yield Buffer.from('x');
        },
      };
      const rejected = assert.rejects(
        client.copyFrom('COPY fixture FROM STDIN', input, { signal: controller.signal }),
        { code: 'PGCLEAR_ABORTED', outcome: 'not-sent' },
      );
      controller.abort();
      await rejected;
      assert.equal(pulls, 0);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      await blocking;
    } finally {
      await client.close();
      await server.close();
    }
  },
);

test('slow socket writes prevent pulling the next COPY source chunk', within, async () => {
  let pulls = 0;
  const firstPull = Promise.withResolvers<void>();
  const paused = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>();
  const payload = Buffer.alloc(16 * 1024 * 1024, 97);
  const server = await fakeServer(async (peer) => {
    await peer.startup();
    peer.socket.write(startupReady);
    await extendedRequest(peer);
    peer.socket.pause();
    peer.socket.write(Buffer.concat([begin, response('in')]));
    paused.resolve();
    await resume.promise;
    peer.socket.resume();
    let size = 0;
    for (;;) {
      const message = await peer.message();
      if (message.type === 'c') break;
      assert.equal(message.type, 'd');
      assert.ok(message.payload.length <= 65536);
      size += message.payload.length;
    }
    assert.equal(size, payload.length + 1);
    assert.equal((await peer.message()).type, 'H');
    peer.socket.write(packet('C', z('COPY 1')));
    await syncReady(peer);
    assert.equal((await peer.message()).type, 'X');
    peer.socket.end();
  });
  const client = await connect({ host: server.host, port: server.port });
  try {
    const input: CopySource = {
      async *[Symbol.asyncIterator]() {
        pulls++;
        firstPull.resolve();
        yield payload;
        pulls++;
        yield Buffer.from('\n');
      },
    };
    const pending = client.copyFrom('COPY fixture FROM STDIN', input);
    await paused.promise;
    await firstPull.promise;
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(pulls, 1);
    resume.resolve();
    await pending;
    assert.equal(pulls, 2);
  } finally {
    resume.resolve();
    await client.close();
    await server.close();
  }
});

test(
  'COPY cancellation sends CopyFail/Sync and a backend-key cancel without waiting for a blocked producer',
  within,
  async () => {
    const started = Promise.withResolvers<void>();
    let returns = 0;
    const server = await fakeServer(async (peer) => {
      const length = (await peer.bytes(4)).readUInt32BE(),
        body = await peer.bytes(length - 4);
      if (body.readUInt32BE() === 80877102) {
        assert.equal(length, 16);
        assert.equal(body.readUInt32BE(4), 123);
        assert.equal(body.readUInt32BE(8), 456);
        peer.socket.end();
        return;
      }
      assert.equal(body.readUInt32BE(), 196608);
      peer.socket.write(startupReady);
      await extendedRequest(peer);
      peer.socket.write(Buffer.concat([begin, response('in')]));
      assert.equal((await peer.message()).type, 'f');
      assert.equal((await peer.message()).type, 'S');
      peer.socket.write(Buffer.concat([error('57014'), ready]));
      assert.equal((await peer.message()).type, 'X');
      peer.socket.end();
    });
    const client = await connect({ host: server.host, port: server.port });
    try {
      const input: CopySource = {
        [Symbol.asyncIterator]() {
          return {
            next() {
              started.resolve();
              return new Promise(() => {});
            },
            async return() {
              returns++;
              return { done: true, value: undefined };
            },
          };
        },
      };
      const controller = new AbortController();
      const failed = assert.rejects(
        client.copyFrom('COPY fixture FROM STDIN', input, { signal: controller.signal }),
        { code: 'PGCLEAR_ABORTED', outcome: 'confirmed' },
      );
      await started.promise;
      controller.abort();
      await failed;
      assert.equal(returns, 1);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    } finally {
      await client.close();
      await server.close();
    }
  },
);

for (const mode of ['in', 'out'] as const)
  test(
    `forced shutdown unblocks stalled COPY ${mode} and clears pool capacity`,
    within,
    async () => {
      const inputStarted = Promise.withResolvers<void>();
      const server = await fakeServer(async (peer) => {
        const length = (await peer.bytes(4)).readUInt32BE(),
          body = await peer.bytes(length - 4);
        if (body.readUInt32BE() === 80877102) {
          await peer.message();
          return;
        }
        assert.equal(body.readUInt32BE(), 196608);
        peer.socket.write(startupReady);
        await extendedRequest(peer);
        peer.socket.write(Buffer.concat([begin, response(mode)]));
        if (mode === 'out') peer.socket.write(packet('d', Buffer.from('paused')));
        await peer.message();
      });
      const pool = createPool({ host: server.host, port: server.port, maxConnections: 1 });
      try {
        const lease = await pool.acquire();
        if (mode === 'in') {
          const source: CopySource = {
            [Symbol.asyncIterator]() {
              return {
                next() {
                  inputStarted.resolve();
                  return new Promise(() => {});
                },
                return() {
                  return new Promise(() => {});
                },
              };
            },
          };
          const failed = assert.rejects(lease.copyFrom('COPY fixture FROM STDIN', source), {
            code: 'PGCLEAR_CLOSED',
          });
          await inputStarted.promise;
          await pool.close({ timeoutMs: 20 });
          await failed;
        } else {
          const stream = lease.copyTo('COPY fixture TO STDOUT');
          await stream[Symbol.asyncIterator]().next();
          const failed = assert.rejects(stream.completion);
          await pool.close({ timeoutMs: 20 });
          await failed;
        }
        assert.equal(pool.stats.total, 0);
      } finally {
        await pool.close();
        await server.close();
      }
    },
  );

test(
  'COPY subprocesses release long deadlines, abort listeners, producers and sockets',
  { timeout: 20000 },
  async () => {
    for (const scenario of [
      'input',
      'output',
      'source-error',
      'source-timeout',
      'output-close',
      'output-abort',
    ] as const) {
      const input = ['input', 'source-error', 'source-timeout'].includes(scenario);
      const server = await sessionServer(
        async (peer) => {
          await extendedRequest(peer);
          peer.socket.write(Buffer.concat([begin, response(input ? 'in' : 'out')]));
          if (scenario === 'input') {
            assert.equal((await peer.message()).type, 'd');
            assert.equal((await peer.message()).type, 'c');
            assert.equal((await peer.message()).type, 'H');
            peer.socket.write(packet('C', z('COPY 1')));
            await syncReady(peer);
          } else if (scenario === 'output') {
            peer.socket.write(
              Buffer.concat([
                packet('d', Buffer.from('bytes')),
                packet('c'),
                packet('C', z('COPY 1')),
              ]),
            );
            await syncReady(peer);
          } else if (input) {
            assert.equal((await peer.message()).type, 'f');
            assert.equal((await peer.message()).type, 'S');
            peer.socket.write(Buffer.concat([error('57014'), ready]));
          } else {
            peer.socket.write(packet('d', Buffer.from('bytes')));
            assert.equal((await peer.message()).type, 'S');
            peer.socket.write(ready);
          }
          assert.equal((await peer.message()).type, 'X');
          peer.socket.end();
        },
        (primary) => {
          if (!input) primary.socket.write(error('57014'));
        },
      );
      try {
        await runLifecycle('copy', scenario, server.port);
        await server.firstClosed;
        assert.equal(server.connections, 0);
      } finally {
        await server.close();
      }
    }
  },
);

test(
  'one cleanup deadline bounds a stalled source return and preserves both failure causes',
  within,
  async () => {
    const server = await fakeServer(async (peer) => {
      await peer.startup();
      peer.socket.write(startupReady);
      await extendedRequest(peer);
      peer.socket.write(Buffer.concat([begin, response('in')]));
      assert.equal((await peer.message()).type, 'f');
      assert.equal((await peer.message()).type, 'S');
      peer.socket.write(Buffer.concat([error('57014'), ready]));
    });
    const client = await connect({ host: server.host, port: server.port });
    try {
      const source: CopySource = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              throw Error('source');
            },
            return() {
              return new Promise(() => {});
            },
          };
        },
      };
      await assert.rejects(client.copyFrom('COPY fixture FROM STDIN', source), (cause) => {
        assert.ok(cause instanceof AggregateError);
        assert.equal(cause.errors[0].code, 'PGCLEAR_COPY_SOURCE');
        assert.equal(cause.errors[1].code, 'PGCLEAR_TIMEOUT');
        return true;
      });
      await assert.rejects(client.queryClassic('SELECT 1', []), { code: 'PGCLEAR_CLOSED' });
    } finally {
      await client.close();
      await server.close();
    }
  },
);

test(
  'verified TLS carries backpressured COPY input and byte output through the same lifecycle',
  within,
  async () => {
    const ca = await readFile(fixturePath('server-cert.pem'), 'utf8');
    const server = await fakeServer(
      async (peer) => {
        await peer.startup();
        peer.socket.write(startupReady);
        await extendedRequest(peer);
        peer.socket.write(Buffer.concat([begin, response('in')]));
        const bytes = await peer.message();
        assert.equal(bytes.type, 'd');
        assert.equal(bytes.payload.toString(), 'encrypted');
        assert.equal((await peer.message()).type, 'c');
        assert.equal((await peer.message()).type, 'H');
        peer.socket.write(packet('C', z('COPY 1')));
        await syncReady(peer);
        await extendedRequest(peer);
        peer.socket.write(
          Buffer.concat([
            begin,
            response('out'),
            packet('d', Buffer.from('encrypted')),
            packet('c'),
            packet('C', z('COPY 1')),
          ]),
        );
        await syncReady(peer);
        assert.equal((await peer.message()).type, 'X');
        peer.socket.end();
      },
      { tls: true },
    );
    const client = await connect({
      host: server.host,
      port: server.port,
      tls: { ca, serverName: 'localhost' },
    });
    try {
      await client.copyFrom('COPY fixture FROM STDIN', source('encrypted'));
      assert.equal(
        (await consume(client.copyTo('COPY fixture TO STDOUT'))).toString(),
        'encrypted',
      );
    } finally {
      await client.close();
      await server.close();
    }
  },
);

test('a synchronous source cannot submit bytes after its elapsed deadline', within, async () => {
  const server = await fakeServer(async (peer) => {
    const length = (await peer.bytes(4)).readUInt32BE(),
      body = await peer.bytes(length - 4);
    if (body.readUInt32BE() === 80877102) {
      peer.socket.end();
      return;
    }
    peer.socket.write(startupReady);
    await extendedRequest(peer);
    peer.socket.write(Buffer.concat([begin, response('in')]));
    assert.equal((await peer.message()).type, 'f');
    assert.equal((await peer.message()).type, 'S');
    peer.socket.write(Buffer.concat([error('57014'), ready]));
    assert.equal((await peer.message()).type, 'X');
    peer.socket.end();
  });
  const client = await connect({ host: server.host, port: server.port });
  try {
    const input: CopySource = {
      async *[Symbol.asyncIterator]() {
        const end = performance.now() + 30;
        while (performance.now() < end) {}
        yield Buffer.from('late');
      },
    };
    await assert.rejects(client.copyFrom('COPY fixture FROM STDIN', input, { timeoutMs: 20 }), {
      code: 'PGCLEAR_TIMEOUT',
      outcome: 'confirmed',
    });
  } finally {
    await client.close();
    await server.close();
  }
});
