import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DriverEvent } from '../../src/index.js';
import { testConnection } from '../helpers/database.js';

const within = { timeout: 10000 };

test(
  'active AbortSignal interruption destroys the session and preserves unknown outcome',
  within,
  async () => {
    const { client, applicationName } = await testConnection(),
      { client: admin } = await testConnection();
    try {
      const controller = new AbortController();
      const interrupted = assert.rejects(
        client.query('SELECT pg_sleep(30)', { signal: controller.signal }),
        {
          code: 'PGCLEAR_ABORTED',
          outcome: 'unknown',
        },
      );
      controller.abort();
      await interrupted;
      await client.close();
      await admin.query({
        text: `SELECT pg_cancel_backend(pid) FROM pg_stat_activity
      WHERE pid=$1 AND application_name=$2`,
        values: [client.info.backendPid, applicationName],
      });
      await assert.rejects(client.query('SELECT 1'), { code: 'PGCLEAR_CLOSED' });
    } finally {
      await client.close();
      await admin.close();
    }
  },
);

test(
  'buffered result limits dispose the connection and settle queued operations',
  within,
  async () => {
    const { client } = await testConnection({ maxResultBytes: 32 });
    try {
      assert.equal(
        (await client.query("SELECT repeat('x', 21) AS value")).rows[0]!.value,
        'x'.repeat(21),
      );
      const limited = assert.rejects(client.query("SELECT repeat('x', 22)"), {
        code: 'PGCLEAR_RESULT_LIMIT',
      });
      const queued = assert.rejects(client.query('SELECT 1'), {
        code: 'PGCLEAR_CLOSED',
        outcome: 'not-sent',
      });
      await Promise.all([limited, queued]);
    } finally {
      await client.close();
    }
  },
);

test(
  'observation failures cannot change a write result and events exclude SQL/values',
  within,
  async (t) => {
    const events: DriverEvent[] = [],
      warnings: unknown[] = [];
    const warning = t.mock.method(process, 'emitWarning', (message: unknown) => {
      warnings.push(message);
    });
    let failObserver = false;
    const { client } = await testConnection({
      onEvent: (event) => {
        events.push(event);
        if (failObserver && event.type === 'operation')
          return Promise.reject(new Error('observer-private-data'));
      },
    });
    try {
      await client.query('CREATE TEMP TABLE observation (value text)');
      failObserver = true;
      const write = await client.query({
        text: 'INSERT INTO observation VALUES ($1)',
        values: ['query-private-value'],
      });
      assert.equal(write.rowCount, 1n);
      assert.deepEqual((await client.query('SELECT value FROM observation')).rows, [
        { value: 'query-private-value' },
      ]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(warnings.length, 2);
      assert.ok(!JSON.stringify(events).includes('INSERT'));
      assert.ok(!JSON.stringify(events).includes('query-private-value'));
      assert.ok(!JSON.stringify(warnings).includes('observer-private-data'));
      await assert.rejects(client.close({ signal: AbortSignal.abort() } as never), {
        code: 'PGCLEAR_CONFIGURATION',
      });
    } finally {
      await client.close();
      warning.mock.restore();
    }
  },
);
