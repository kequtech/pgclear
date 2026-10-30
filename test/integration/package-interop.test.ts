import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { databaseUrl } from '../helpers/database.js';

const run = promisify(execFile);
type Driver = typeof import('../../src/index.js');

test(
  'two installations exchange parameters, selected registries and error identities',
  { timeout: 20000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pgclear-interop-'));
    const root = process.cwd();
    try {
      const packed = await run('npm', [
        'pack',
        '--ignore-scripts',
        '--json',
        '--pack-destination',
        directory,
      ]);
      const [archive] = JSON.parse(packed.stdout) as { filename: string }[];
      const copies: Driver[] = [];
      for (const name of ['one', 'two']) {
        const target = join(directory, name, 'node_modules', '@kequtech', 'pgclear');
        await mkdir(target, { recursive: true });
        await run('tar', [
          '-xzf',
          join(directory, archive!.filename),
          '-C',
          target,
          '--strip-components=1',
        ]);
        const manifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8')) as {
          dependencies?: Record<string, string>;
        };
        for (const dependency of Object.keys(manifest.dependencies ?? {})) {
          const link = join(directory, name, 'node_modules', dependency);
          await mkdir(resolve(link, '..'), { recursive: true });
          await symlink(join(root, 'node_modules', dependency), link, 'dir');
        }
        copies.push((await import(pathToFileURL(join(target, 'dist/index.js')).href)) as Driver);
      }
      const [a, b] = copies as [Driver, Driver];
      assert.notEqual(a.defaultCodecs, b.defaultCodecs);
      assert.notEqual(a.DriverError, b.DriverError);
      for (const [owner, other] of [
        [a, b],
        [b, a],
      ] as const) {
        class ChildError extends owner.DriverError {}
        const base = new owner.DriverError('PGCLEAR_ABORTED', 'fixture');
        const child = new ChildError('PGCLEAR_ABORTED', 'fixture');
        assert.ok(child instanceof owner.DriverError);
        assert.ok(child instanceof other.DriverError);
        assert.ok(child instanceof ChildError);
        assert.equal(base instanceof ChildError, false);
        for (const value of [null, undefined, 1, {}, new Error('fixture')]) {
          assert.equal(value instanceof owner.DriverError, false);
          assert.equal(value instanceof other.DatabaseError, false);
        }
        const codecs = other.defaultCodecs.with(owner.builtin.int4).with(owner.builtin.jsonbText);
        assert.equal(codecs.isDefaultDecoder(23), true);
        assert.equal(codecs.isDefaultDecoder(1007), true);
        assert.equal(codecs.isDefaultDecoder(3802), false);
        assert.equal(codecs.isDefaultDecoder(987654), true);
        assert.equal(
          other.defaultCodecs.with(owner.builtin.int4Array).isDefaultDecoder(1007),
          true,
        );
        const custom = other.defaultCodecs.with({
          oid: 23,
          text: {
            encode: String,
            decode: (value: string) => ({ value }),
            typescript: '{value: string}',
          },
        });
        const pool = owner.createPool({
          connectionString: databaseUrl(),
          codecs,
          maxConnections: 1,
        });
        try {
          assert.equal(pool.codecs, codecs);
          const query = other.sql`SELECT ${other.json({ ok: true })}::jsonb AS document,${other.param([1, null, 2], other.builtin.int4Array)} AS items`;
          assert.deepEqual((await pool.query(query)).rows, [
            { document: '{"ok": true}', items: [1, null, 2] },
          ]);
          assert.deepEqual(
            (
              await pool.queryClassic('SELECT 42 AS value,ARRAY[42,NULL] AS items', [], {
                codecs: custom,
              })
            ).rows,
            [{ value: { value: '42' }, items: [{ value: '42' }, null] }],
          );
          assert.equal(pool.codecs.typescript(23), 'number');
          assert.equal(pool.codecs.isDefaultDecoder(23), true);
          assert.equal(custom.isDefaultDecoder(23), false);
          assert.equal(custom.isDefaultDecoder(1007), false);
          assert.ok(custom.typescriptTypes().includes('PgArray<{value: string}>'));
          const lease = await pool.acquire();
          try {
            assert.equal(lease.codecs, codecs);
            const prepared = await lease.prepare('SELECT $1::integer AS value');
            try {
              assert.deepEqual(
                (await prepared.query([other.param(42, other.builtin.int4)], { codecs: custom }))
                  .rows,
                [{ value: { value: '42' } }],
              );
            } finally {
              await prepared.close();
            }
            await assert.rejects(
              pool.queryClassic('SELECT 1', [], { timeoutMs: 25 }),
              (error: unknown) => {
                assert.ok(error instanceof owner.DriverError);
                assert.ok(error instanceof other.DriverError);
                assert.equal(error.code, 'PGCLEAR_TIMEOUT');
                assert.equal(error.outcome, 'not-sent');
                return true;
              },
            );
          } finally {
            await lease.release();
          }
          await assert.rejects(lease.queryClassic('SELECT 1', [], { codecs: custom }), {
            code: 'PGCLEAR_EXPIRED',
          });
          await assert.rejects(pool.queryClassic('SELECT 1/0'), (error: unknown) => {
            assert.ok(error instanceof owner.DatabaseError);
            assert.ok(error instanceof other.DatabaseError);
            assert.equal(error.code, '22012');
            return true;
          });
          assert.deepEqual((await pool.queryClassic('SELECT 1 AS value')).rows, [{ value: 1 }]);
        } finally {
          await pool.close();
        }
      }
      await writeFile(join(directory, 'package.json'), '{"type":"module"}');
      await mkdir(join(directory, 'node_modules/@types'), { recursive: true });
      await symlink(
        join(root, 'node_modules/@types/node'),
        join(directory, 'node_modules/@types/node'),
        'dir',
      );
      await writeFile(
        join(directory, 'consumer.ts'),
        `
      import * as a from './one/node_modules/@kequtech/pgclear/dist/index.js';
      import * as b from './two/node_modules/@kequtech/pgclear/dist/index.js';
      async function exchange(pool:a.Pool,session:b.Session) {
        const codec:a.CodecRegistry=session.codecs;
        const unchanged:boolean=codec.isDefaultDecoder(23);
        void unchanged;
        await pool.query(a.sql\`SELECT \${b.json({ok:true})}\`,{codecs:codec});
        await session.queryClassic('SELECT 1',[],{codecs:a.defaultCodecs});
        const owned=a.createPool({codecs:b.defaultCodecs});
        await owned.close();
      }
      void exchange;
    `,
      );
      await run(
        process.execPath,
        [
          join(root, 'node_modules/typescript/bin/tsc'),
          '--ignoreConfig',
          '--noEmit',
          '--strict',
          '--target',
          'ES2024',
          '--module',
          'NodeNext',
          '--types',
          'node',
          'consumer.ts',
        ],
        { cwd: directory },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
