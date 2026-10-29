import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DriverEvent } from '../../src/index.js';
import { testConnection } from '../helpers/database.js';

const within = { timeout: 10000 };

test(
  'active AbortSignal cancellation observes the server response and retires the session',
  within,
  async () => {
    const { client, applicationName } = await testConnection(),
      { client: admin } = await testConnection();
    try {
      const controller = new AbortController();
      const interrupted = assert.rejects(
        client.queryClassic('SELECT pg_sleep(30)', [], { signal: controller.signal }),
        {
          code: 'PGCLEAR_ABORTED',
          outcome: 'confirmed',
        },
      );
      controller.abort();
      await interrupted;
      await client.close();
      const remaining = await admin.queryClassic(
        'SELECT count(*) AS n FROM pg_stat_activity WHERE pid=$1 AND application_name=$2',
        [client.info.backendPid, applicationName],
      );
      assert.equal(remaining.rows[0]!.n, '0');
      await assert.rejects(client.queryClassic('SELECT 1', []), { code: 'PGCLEAR_CLOSED' });
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
    const { client } = await testConnection({ maxResultBytes: 128 });
    try {
      assert.equal(
        (await client.queryClassic("SELECT repeat('x', 72) AS value", [])).rows[0]!.value,
        'x'.repeat(72),
      );
      const limited = assert.rejects(client.queryClassic("SELECT repeat('x', 73)", []), {
        code: 'PGCLEAR_RESULT_LIMIT',
      });
      const queued = assert.rejects(client.queryClassic('SELECT 1', []), {
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
      await client.queryClassic('CREATE TEMP TABLE observation (value text)', []);
      failObserver = true;
      const write = await client.queryClassic('INSERT INTO observation VALUES ($1)', [
        'query-private-value',
      ]);
      assert.equal(write.rowCount, 1);
      assert.deepEqual((await client.queryClassic('SELECT value FROM observation', [])).rows, [
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
