import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { databaseUrl, ownedName } from '../helpers/database.js';

const run = promisify(execFile);
type Driver = typeof import('../../src/index.js');

test(
  'two installations exchange public values, generation scopes and error identities',
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
          dependencies: Record<string, string>;
        };
        for (const dependency of Object.keys(manifest.dependencies)) {
          const link = join(directory, name, 'node_modules', dependency);
          await mkdir(resolve(link, '..'), { recursive: true });
          await symlink(join(root, 'node_modules', dependency), link, 'dir');
        }
        copies.push((await import(pathToFileURL(join(target, 'dist/index.js')).href)) as Driver);
      }
      const [a, b] = copies as [Driver, Driver];
      assert.notEqual(a.defaultCodecs, b.defaultCodecs);
      assert.notEqual(a.DriverError, b.DriverError);

      const namespace = ownedName();
      // Exercise both directions; the registry and its builtin overrides also cross copies.
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
        assert.equal(codecs.typescript(23), 'number');
        assert.equal(codecs.typescript(3802), 'string');
        const pool = owner.createPool({
          connectionString: databaseUrl(),
          codecs,
          maxConnections: 1,
        });
        try {
          await pool.query(`CREATE SCHEMA ${namespace}`);
          try {
            await pool.query(
              `CREATE TABLE ${namespace}.items(id integer NOT NULL, document jsonb)`,
            );
            const query = other.sql`SELECT ${other.json({ ok: true })}::jsonb AS document,
              ${other.param([1, null, 2], other.builtin.int4Array)} AS items`;
            assert.deepEqual((await pool.query(query)).rows, [
              { document: '{"ok": true}', items: [1, null, 2] },
            ]);
            const warnings: string[] = [];
            const source = await other.generateDefinitions({
              connection: pool,
              namespace,
              onWarning: (message) => {
                warnings.push(message);
              },
            });
            assert.deepEqual(warnings, []);
            assert.equal(source, await owner.generateDefinitions({ connection: pool, namespace }));
            await writeFile(join(directory, 'schema.d.ts'), source);

            const custom = other.defaultCodecs.with({
              oid: 23,
              text: { encode: String, decode: (value: string) => ({ value }) },
            });
            assert.equal(custom.typescript(23), undefined);
            assert.equal(custom.typescript(1007), undefined);
            const customPool = owner.createPool({
              connectionString: databaseUrl(),
              codecs: custom,
            });
            try {
              assert.deepEqual(
                (await customPool.query('SELECT 42 AS value, ARRAY[42] AS items')).rows,
                [{ value: { value: '42' }, items: [{ value: '42' }] }],
              );
              const unresolved: string[] = [];
              await writeFile(
                join(directory, 'custom-schema.d.ts'),
                await other.generateDefinitions({
                  connection: customPool,
                  namespace,
                  onWarning: (message) => {
                    unresolved.push(message);
                  },
                }),
              );
              assert.equal(unresolved.length, 1);
            } finally {
              await customPool.close();
            }

            const lease = await pool.acquire();
            try {
              assert.equal(
                await other.generateDefinitions({ connection: lease, namespace }),
                source,
              );
              const prepared = await lease.prepare('SELECT $1::integer AS value');
              try {
                assert.deepEqual(
                  (await prepared.query([other.param(42, other.builtin.int4)])).rows,
                  [{ value: 42 }],
                );
              } finally {
                await prepared.close();
              }
              // A deadline created in the generator copy must remain a timeout in the pool copy.
              await assert.rejects(
                other.generateDefinitions({ connection: pool, namespace, timeoutMs: 25 }),
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
            await assert.rejects(other.generateDefinitions({ connection: lease, namespace }), {
              code: 'PGCLEAR_EXPIRED',
            });
            await assert.rejects(pool.query('SELECT 1/0'), (error: unknown) => {
              assert.ok(error instanceof owner.DatabaseError);
              assert.ok(error instanceof other.DatabaseError);
              assert.equal(error.code, '22012');
              return true;
            });
            assert.deepEqual((await pool.query('SELECT 1 AS value')).rows, [{ value: 1 }]);
          } finally {
            await pool.query(`DROP SCHEMA ${namespace} CASCADE`);
          }
        } finally {
          await pool.close();
        }
      }

      // The two declarations must accept exactly the objects exchanged at runtime.
      await writeFile(join(directory, 'package.json'), '{"type":"module"}');
      await mkdir(join(directory, 'node_modules/@types'), { recursive: true });
      await symlink(
        join(root, 'node_modules/@types/node'),
        join(directory, 'node_modules/@types/node'),
        'dir',
      );
      await mkdir(join(directory, 'node_modules/@kequtech'), { recursive: true });
      await symlink(
        join(directory, 'one/node_modules/@kequtech/pgclear'),
        join(directory, 'node_modules/@kequtech/pgclear'),
        'dir',
      );
      await writeFile(
        join(directory, 'consumer.ts'),
        `
        import * as a from './one/node_modules/@kequtech/pgclear/dist/index.js';
        import * as b from './two/node_modules/@kequtech/pgclear/dist/index.js';
        import type { Database } from './schema.js';
        import type { Database as CustomDatabase } from './custom-schema.js';
        declare const row: Database['items']['row'];
        const id: number = row.id;
        const document: string | null = row.document;
        const representation: string | undefined = b.defaultCodecs.typescript(23);
        declare const custom: CustomDatabase['items']['row'];
        // @ts-expect-error custom decoder output is unresolved, never guessed as the default number
        const guessed: number = custom.id;
        async function exchange(pool: a.Pool, session: b.Session) {
          await pool.query(a.sql\`SELECT \${b.json({ok:true})}\`);
          await a.generateDefinitions({connection: session});
          await b.generateDefinitions({connection: pool});
          const owned = a.createPool({codecs: b.defaultCodecs});
          await owned.close();
        }
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
