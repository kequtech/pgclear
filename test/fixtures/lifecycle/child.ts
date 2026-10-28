import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import type { Connection, CopySource, OperationOptions } from '../../../src/index.js';

// Exercise the built package, while typechecking fixtures against its public source contract.
const { connect, createPool }: typeof import('../../../src/index.js') = await import(
  pathToFileURL(resolve('dist/index.js')).href
);
const [kind, scenario, port] = process.argv.slice(2);
const connection = { host: '127.0.0.1', port: Number(port) };
assert.ok(scenario);
const controller = new AbortController();
const options = {
  signal: controller.signal,
  timeoutMs: scenario === 'timeout' || scenario === 'source-timeout' ? 25 : 3600000,
};
let timer: ReturnType<typeof setTimeout> | undefined;

async function stream(client: Connection) {
  const output = client.stream('SELECT n', { ...options, batchSize: 2 });
  if (scenario === 'abort') timer = setTimeout(() => controller.abort(), 25);
  if (scenario === 'complete') {
    for await (const row of output) assert.equal(row.n, 1);
    assert.equal((await output.completion).status, 'complete');
  } else if (scenario === 'close') {
    await output.fields;
    await output.close();
    assert.deepEqual(await output.completion, { status: 'closed' });
  } else {
    const code =
      scenario === 'error'
        ? 'XX000'
        : scenario === 'timeout'
          ? 'PGCLEAR_TIMEOUT'
          : 'PGCLEAR_ABORTED';
    await assert.rejects(output.completion, { code });
  }
}
async function copy(client: Connection) {
  if (scenario === 'input') {
    const source = Readable.from([Buffer.from('bytes')]);
    assert.equal((await client.copyFrom('COPY fixture FROM STDIN', source, options)).rowCount, 1n);
    assert.equal(source.destroyed, true);
  } else if (scenario === 'source-error' || scenario === 'source-timeout') {
    let stopped = false;
    const source: CopySource = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            return scenario === 'source-error'
              ? Promise.reject(Error('fixture'))
              : new Promise<IteratorResult<Uint8Array>>(() => {});
          },
          async return() {
            stopped = true;
            return { done: true, value: undefined };
          },
        };
      },
    };
    await assert.rejects(client.copyFrom('COPY fixture FROM STDIN', source, options), {
      code: scenario === 'source-error' ? 'PGCLEAR_COPY_SOURCE' : 'PGCLEAR_TIMEOUT',
    });
    assert.equal(stopped, true);
  } else {
    const output = client.copyTo('COPY fixture TO STDOUT', options);
    if (scenario === 'output') {
      for await (const chunk of output) assert.equal(Buffer.from(chunk).toString(), 'bytes');
      assert.equal((await output.completion).status, 'complete');
    } else if (scenario === 'output-close') {
      for await (const chunk of output) {
        assert.ok(chunk.length);
        break;
      }
      assert.deepEqual(await output.completion, { status: 'closed' });
    } else {
      assert.equal(scenario, 'output-abort');
      await output[Symbol.asyncIterator]().next();
      controller.abort();
      await assert.rejects(output.completion, { code: 'PGCLEAR_ABORTED' });
    }
  }
}
async function description(client: Connection, options: OperationOptions) {
  if (scenario === 'abort') timer = setTimeout(() => controller.abort(), 25);
  const work =
    kind === 'prepare' ? client.prepare('SELECT 1', options) : client.describe('BEGIN', options);
  if (scenario === 'success') {
    const result = await work;
    if ('close' in result) await result.close();
    else assert.deepEqual(result.parameterTypes, [23]);
  } else {
    await assert.rejects(work, {
      code:
        scenario === 'server-error'
          ? kind === 'prepare'
            ? 'XX000'
            : '42601'
          : scenario === 'timeout'
            ? 'PGCLEAR_TIMEOUT'
            : 'PGCLEAR_ABORTED',
    });
  }
}

if (kind === 'pool') {
  const pool = createPool({ ...connection, maxConnections: 1 });
  const [operation, fail] = scenario.split(':');
  try {
    const callback = async () => {
      if (fail === 'true') throw Error('fixture');
      return 42;
    };
    const work =
      operation === 'transaction'
        ? pool.transaction(callback, options)
        : pool.withSession(callback, options);
    if (fail === 'true') await assert.rejects(work, /fixture/);
    else assert.equal(await work, 42);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  } finally {
    await pool.close();
  }
} else {
  const client = await connect(connection);
  try {
    switch (kind) {
      case 'describe':
      case 'prepare':
        await description(client, options);
        break;
      case 'stream':
        await stream(client);
        break;
      case 'copy':
        await copy(client);
        break;
      default:
        throw Error('Unknown lifecycle fixture.');
    }
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  } finally {
    clearTimeout(timer);
    await client.close();
  }
}
