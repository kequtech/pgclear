import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import { createSecureContext, TLSSocket } from 'node:tls';
import { readFile } from 'node:fs/promises';
import { Reader } from '../../src/protocol/messages.js';

export const fixtures = new URL('../../../test/fixtures/', import.meta.url);
// Compiled tests run under .test-dist; the certificate files stay in the original fixture directory.
export const fixturePath = (name: string) => new URL(name, fixtures);

export function packet(type: string, payload: Buffer = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(5);
  header[0] = type.charCodeAt(0);
  header.writeUInt32BE(payload.length + 4, 1);
  return Buffer.concat([header, payload]);
}
export function i32(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeInt32BE(value);
  return b;
}
export function z(value: string): Buffer {
  return Buffer.from(value + '\0');
}
export function auth(method: number, extra: Buffer = Buffer.alloc(0)): Buffer {
  return packet('R', Buffer.concat([i32(method), extra]));
}
export const ready = packet('Z', Buffer.from('I'));
export const startupReady = Buffer.concat([
  auth(0),
  packet('S', Buffer.concat([z('server_version'), z('16.0')])),
  packet('K', Buffer.concat([i32(123), i32(456)])),
  ready,
]);

export class Peer {
  #chunks: Buffer[] = [];
  #size = 0;
  #ended = false;
  #wait: (() => void) | undefined;
  constructor(readonly socket: Socket) {
    socket.on('data', (chunk) => {
      this.#chunks.push(chunk);
      this.#size += chunk.length;
      this.#wait?.();
    });
    socket.on('error', () => {
      this.#ended = true;
      this.#wait?.();
    });
    socket.on('close', () => {
      this.#ended = true;
      this.#wait?.();
    });
  }
  async bytes(count: number): Promise<Buffer> {
    while (this.#size < count) {
      if (this.#ended) throw new Error('Peer closed.');
      await new Promise<void>((resolve) => {
        this.#wait = resolve;
      });
      this.#wait = undefined;
    }
    const all = Buffer.concat(this.#chunks);
    const result = all.subarray(0, count);
    this.#chunks = all.length === count ? [] : [all.subarray(count)];
    this.#size -= count;
    return result;
  }
  async startup(): Promise<Map<string, string>> {
    const length = (await this.bytes(4)).readUInt32BE();
    assert.ok(length >= 8 && length < 65536);
    const body = new Reader(await this.bytes(length - 4));
    assert.equal(body.int32(), 196608);
    const values = new Map<string, string>();
    for (let key = body.cstring(); key; key = body.cstring()) values.set(key, body.cstring());
    body.end();
    return values;
  }
  async message(): Promise<{ type: string; payload: Buffer }> {
    const header = await this.bytes(5),
      length = header.readUInt32BE(1);
    assert.ok(length >= 4 && length < 1024 * 1024);
    return { type: String.fromCharCode(header[0]!), payload: await this.bytes(length - 4) };
  }
}

export async function fakeServer(
  handler: (peer: Peer) => Promise<void>,
  options: { tls?: boolean; unixPath?: string } = {},
) {
  const sockets = new Set<Socket>(),
    tasks = new Set<Promise<void>>(),
    errors: unknown[] = [];
  const closed = Promise.withResolvers<void>();
  const context = options.tls
    ? createSecureContext({
        key: await readFile(fixturePath('server-key.pem')),
        cert: await readFile(fixturePath('server-cert.pem')),
      })
    : undefined;
  const server = createServer((raw) => {
    sockets.add(raw);
    raw.on('error', () => {});
    raw.once('close', () => {
      sockets.delete(raw);
      closed.resolve();
    });
    const run = async () => {
      let socket: Socket = raw;
      if (context) {
        const peer = new Peer(raw);
        assert.deepEqual(await peer.bytes(8), Buffer.from('0000000804d2162f', 'hex'));
        raw.removeAllListeners('data');
        raw.write('S');
        socket = new TLSSocket(raw, { isServer: true, secureContext: context });
      }
      await handler(new Peer(socket));
    };
    const task = run().catch((error) => {
      if (!(error instanceof Error && error.message === 'Peer closed.')) errors.push(error);
      raw.destroy();
    });
    tasks.add(task);
    void task.finally(() => tasks.delete(task));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    if (options.unixPath) server.listen(options.unixPath, resolve);
    else server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    host: '127.0.0.1',
    port: typeof address === 'object' && address ? address.port : 5432,
    firstClosed: closed.promise,
    get connections() {
      return sockets.size;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await Promise.all(tasks);
      if (errors.length) throw new AggregateError(errors, 'Fake-server assertion failed.');
    },
  };
}
