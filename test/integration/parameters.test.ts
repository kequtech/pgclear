import assert from 'node:assert/strict';
import { test } from 'node:test';
import { builtin, param, type InputValue } from '../../src/index.js';
import { testConnection } from '../helpers/database.js';

test(
  'the unsigned protocol count supports 65,535 bound parameters without JS argument spreading',
  { timeout: 10000 },
  async () => {
    const { client } = await testConnection();
    try {
      const values: InputValue[] = Array<InputValue>(65535).fill(param(null, builtin.int4));
      values[65534] = param(7, builtin.int4);
      const result = await client.queryClassic('SELECT $65535 AS value', values);
      assert.deepEqual(result.rows, [{ value: 7 }]);
      await assert.rejects(client.queryClassic('SELECT 1', Array<InputValue>(65536).fill(null)), {
        code: 'PGCLEAR_ENCODE',
        outcome: 'not-sent',
      });
      assert.deepEqual((await client.queryClassic('SELECT 1 AS value', [])).rows, [{ value: 1 }]);
    } finally {
      await client.close();
    }
  },
);
