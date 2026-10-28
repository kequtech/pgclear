import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { InputValue } from '../../src/index.js';
import { testConnection } from '../helpers/database.js';

test(
  'the unsigned protocol count supports 65,535 bound parameters without JS argument spreading',
  { timeout: 10000 },
  async () => {
    const { client } = await testConnection();
    try {
      const values: InputValue[] = Array<InputValue>(65535).fill(null);
      values[65534] = 7;
      const result = await client.query({
        text: 'SELECT $65535 AS value',
        values,
        parameterTypes: Array<number>(65535).fill(23),
      });
      assert.deepEqual(result.rows, [{ value: 7 }]);
      await assert.rejects(
        client.query({ text: 'SELECT 1', values: Array<InputValue>(65536).fill(null) }),
        { code: 'PGCLEAR_ENCODE', outcome: 'not-sent' },
      );
      assert.deepEqual((await client.query('SELECT 1 AS value')).rows, [{ value: 1 }]);
    } finally {
      await client.close();
    }
  },
);
