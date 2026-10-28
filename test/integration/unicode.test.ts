import assert from 'node:assert/strict';
import { test } from 'node:test';
import { builtin, param } from '../../src/index.js';
import { parseArray } from '../../src/codecs/arrays.js';
import { testConnection } from '../helpers/database.js';

const within = { timeout: 10000 };
const unicode = [
  0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008,
  0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
].map((code) => String.fromCodePoint(code));

test(
  'real text, column names, descriptions and scripts preserve leading U+FEFF',
  within,
  async () => {
    const { client } = await testConnection();
    try {
      for (const value of [
        '\ufeffhello',
        '\ufeff',
        '\ufeff\ufeffhello',
        '\ufeffé😀',
        'hello\ufeff',
      ]) {
        const result = await client.query({ text: 'SELECT $1::text AS value', values: [value] });
        assert.deepEqual(result.rows, [{ value }]);
      }
      assert.deepEqual((await client.query("SELECT chr(65279)||'hello' AS value")).rows, [
        { value: '\ufeffhello' },
      ]);
      const text = 'SELECT 1 AS value, 2 AS "\ufeffvalue"';
      const result = await client.query(text);
      assert.deepEqual(result.rows, [{ value: 1, '\ufeffvalue': 2 }]);
      assert.deepEqual(
        result.fields.map((field) => field.name),
        ['value', '\ufeffvalue'],
      );
      assert.deepEqual(
        (await client.describe(text)).fields.map((field) => field.name),
        ['value', '\ufeffvalue'],
      );
      assert.deepEqual(
        (await client.script(text + "; SELECT chr(65279)||'hello' AS value")).map(
          (result) => result.rows,
        ),
        [[{ value: 1, '\ufeffvalue': 2 }], [{ value: '\ufeffhello' }]],
      );
    } finally {
      await client.close();
    }
  },
);

test(
  'text array round trips preserve Unicode whitespace and agree with server JSON',
  within,
  async () => {
    const { client } = await testConnection();
    try {
      const values: (string | null)[] = [
        null,
        ...unicode.flatMap((char) => [
          char + 'hello',
          'hello' + char,
          char,
          char + 'NULL' + char,
          char + 'é😀' + char,
          'quote"' + char,
          'slash\\' + char,
        ]),
      ];
      const row = (
        await client.query({
          text: 'SELECT $1::text[] AS value,array_to_json($1::text[]) AS oracle',
          values: [param(values, builtin.textArray)],
        })
      ).rows[0]!;
      assert.deepEqual(row.oracle, values);
      assert.deepEqual(row.value, row.oracle);
      const nested = (
        await client.query('SELECT array_fill(chr(160),ARRAY[2,2],ARRAY[-1,0]) AS value')
      ).rows[0]!.value;
      assert.deepEqual(nested, [
        ['\u00a0', '\u00a0'],
        ['\u00a0', '\u00a0'],
      ]);
    } finally {
      await client.close();
    }
  },
);

test(
  'text-array whitespace grammar agrees with PostgreSQL input rather than JavaScript trim',
  within,
  async () => {
    const { client } = await testConnection();
    try {
      const literals = unicode.map(
        (char) => '{' + char + 'hello,hello' + char + ',' + char + ',' + char + 'NULL' + char + '}',
      );
      for (const char of [' ', '\t', '\n', '\r', '\v', '\f']) {
        literals.push(char + '{' + char + 'hello' + char + ',' + char + 'NULL' + char + '}' + char);
        literals.push('{\\' + char + 'hello,hello\\' + char + '}');
      }
      for (const text of literals) {
        const oracle = (
          await client.query({ text: 'SELECT array_to_json($1::text[]) AS value', values: [text] })
        ).rows[0]!.value;
        assert.deepEqual(
          parseArray(text, (value) => value),
          oracle,
          JSON.stringify(text),
        );
      }
    } finally {
      await client.close();
    }
  },
);
