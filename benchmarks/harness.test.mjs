import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, connect } from 'node:net';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { relay } from './relay.mjs';
import { summarize } from './stats.mjs';

test('workload selection refuses unknown names before database access', () => {
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [fileURLToPath(new URL('./run.mjs', import.meta.url)), '--workloads', 'unknown'],
        { env: {}, stdio: 'pipe' },
      ),
    (error) => error.status === 1 && /Unknown benchmark workload/.test(error.stderr.toString()),
  );
});

test('direct transport refuses artificial RTT before opening a database or building a package', () => {
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [
          fileURLToPath(new URL('./run.mjs', import.meta.url)),
          '--transport',
          'direct',
          '--latencies',
          '10',
        ],
        { env: {}, stdio: 'pipe' },
      ),
    (error) =>
      error.status === 1 && /Direct transport requires --latencies 0/.test(error.stderr.toString()),
  );
});

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
