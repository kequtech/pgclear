import assert from 'node:assert/strict';
import { test } from 'node:test';
import { builtin, param } from '../../src/index.js';
import { prohibited, unassigned } from '../../src/auth/saslprep-tables.js';
import { testConnection } from '../helpers/database.js';

test(
  'native NFKC agrees with PostgreSQL for every changing stringprep-assigned character',
  { timeout: 15000 },
  async () => {
    const values: string[] = [];
    for (let point = 1; point <= 0x10ffff; point++) {
      const value = String.fromCodePoint(point);
      if (!prohibited.test(value) && !unassigned.test(value) && value.normalize('NFKC') !== value)
        values.push(value);
    }
    assert.ok(values.length > 1000);
    const { client } = await testConnection();
    try {
      const result = await client.query<{ value: string }>([
        'SELECT normalize(value, NFKC) AS value FROM unnest($1::text[]) WITH ORDINALITY AS input(value, ordinal) ORDER BY ordinal',
        [param(values, builtin.textArray)],
      ]);
      assert.deepEqual(
        result.rows.map((row) => row.value),
        values.map((value) => value.normalize('NFKC')),
      );
    } finally {
      await client.close();
    }
  },
);
