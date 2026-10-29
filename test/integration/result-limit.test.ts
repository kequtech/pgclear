import assert from 'node:assert/strict';
import { test } from 'node:test';
import { testConnection } from '../helpers/database.js';

test(
  'NULL and empty values consume result budget through their row framing',
  { timeout: 10000 },
  async () => {
    for (const projection of ['NULL::text', "''::text"]) {
      const { client } = await testConnection({ maxResultBytes: 128 });
      try {
        await assert.rejects(
          client.queryClassic(`SELECT ${projection} FROM generate_series(1, 100)`, []),
          {
            code: 'PGCLEAR_RESULT_LIMIT',
            outcome: 'unknown',
          },
        );
      } finally {
        await client.close();
      }
    }
  },
);
