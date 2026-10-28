import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateDefinitions } from '../src/index.js';

test('generation rejects invalid options before acquiring a connection', async () => {
  for (const options of [
    undefined,
    null,
    {},
    { connection: null },
    { connection: {}, namespace: '' },
    { connection: {}, namespace: 'x\0' },
    { connection: {}, excludeTables: [undefined] },
    { connection: {}, excludeTables: Array(1) },
    { connection: {}, onWarning: 1 },
    { connection: { transaction: true } },
  ]) {
    await assert.rejects(generateDefinitions(options as never), { code: 'PGCLEAR_CONFIGURATION' });
  }
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(generateDefinitions({ connection: {}, signal: controller.signal }), {
    code: 'PGCLEAR_ABORTED',
    outcome: 'not-sent',
  });
  await assert.rejects(generateDefinitions({ connection: {}, timeoutMs: 0 }), {
    code: 'PGCLEAR_TIMEOUT',
    outcome: 'not-sent',
  });
});
