import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, connect } from 'node:net';
import { relay } from './relay.mjs';
import { summarize } from './stats.mjs';

test('benchmark percentiles use numeric order without changing raw measurements', () => {
  const samples = [100, 2, 10, 1];
  assert.deepEqual(summarize(samples), { min: 1, median: 2, p95: 100, p99: 100, max: 100 });
  assert.deepEqual(samples, [100, 2, 10, 1]);
  for (const invalid of [[], [-1], [NaN], [Infinity]]) assert.throws(() => summarize(invalid));
});
test('latency relay preserves bytes and releases half-closed sockets with bounded buffering', async () => {
  const echo = createServer({ allowHalfOpen: true }, (socket) => socket.pipe(socket));
  await new Promise((resolve) => echo.listen(0, '127.0.0.1', resolve));
  const proxy = await relay('127.0.0.1', echo.address().port, 20);
  const expected = Buffer.alloc(2 * 1024 * 1024, 42);
  try {
    const received = await new Promise((resolve, reject) => {
      const chunks = [],
        socket = connect(proxy.port, '127.0.0.1');
      socket.on('data', (chunk) => chunks.push(chunk));
      socket.on('error', reject);
      socket.on('end', () => resolve(Buffer.concat(chunks)));
      socket.on('connect', () => socket.end(expected));
    });
    assert.deepEqual(received, expected);
  } finally {
    await proxy.close();
    await new Promise((resolve) => echo.close(resolve));
  }
});
