import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fakeServer, startupReady, packet, ready, z } from './helpers/server.js';

const run = promisify(execFile);

test(
  'packed JavaScript and TypeScript consumers use only real exports and exit after close',
  { timeout: 15000 },
  async () => {
    const root = process.cwd(),
      directory = await mkdtemp(join(tmpdir(), 'pgclear-consumer-'));
    const packagePath = join(directory, 'node_modules', '@kequtech', 'pgclear');
    const server = await fakeServer(async (peer) => {
      await peer.startup();
      peer.socket.write(startupReady);
      assert.equal((await peer.message()).type, 'P');
      assert.equal((await peer.message()).type, 'D');
      assert.equal((await peer.message()).type, 'S');
      peer.socket.write(
        Buffer.concat([packet('1'), packet('t', Buffer.from([0, 0])), packet('n'), ready]),
      );
      assert.equal((await peer.message()).type, 'Q');
      peer.socket.write(
        Buffer.concat([packet('C', z('BEGIN')), packet('C', z('ROLLBACK')), ready]),
      );
      assert.equal((await peer.message()).type, 'X');
      peer.socket.end();
    });
    try {
      const packed = await run(
        'npm',
        ['pack', '--ignore-scripts', '--json', '--pack-destination', directory],
        { cwd: root },
      );
      const [archive] = JSON.parse(packed.stdout) as {
        filename: string;
        files: { path: string }[];
      }[];
      assert.ok(archive!.files.some((file) => file.path === 'dist/index.js'));
      assert.ok(archive!.files.some((file) => file.path === 'dist/index.d.ts'));
      assert.ok(
        !archive!.files.some((file) => /^(?:src|test|\.env|\.test-dist)(?:\/|$)/.test(file.path)),
      );
      await mkdir(packagePath, { recursive: true });
      await run('tar', [
        '-xzf',
        join(directory, archive!.filename),
        '-C',
        packagePath,
        '--strip-components=1',
      ]);
      const manifest = JSON.parse(await readFile(join(packagePath, 'package.json'), 'utf8')) as {
        dependencies: Record<string, string>;
        private: boolean;
      };
      assert.equal(manifest.private, true);
      // Reuse installed dependencies, but only those actually declared by the packed manifest.
      for (const dependency of [...Object.keys(manifest.dependencies), '@types/node']) {
        const target = join(directory, 'node_modules', dependency);
        await mkdir(resolve(target, '..'), { recursive: true });
        await symlink(join(root, 'node_modules', dependency), target, 'dir');
      }
      await writeFile(join(directory, 'package.json'), '{"type":"module"}');
      await writeFile(
        join(directory, 'index.mjs'),
        `
      import assert from 'node:assert/strict';
      import * as driver from '@kequtech/pgclear';
      assert.deepEqual(Object.keys(driver).sort(), ['DatabaseError', 'DriverError', 'builtin', 'connect', 'createPool', 'defaultCodecs', 'json', 'param', 'sql']);
      assert.deepEqual(driver.sql\`SELECT \${42}::integer AS value\`, ['SELECT $1::integer AS value', [42]]);
      const client = await driver.connect({host: '127.0.0.1', port: ${server.port}});
      assert.equal(client.info.backendPid, 123);
      assert.deepEqual(await client.describe('BEGIN'), {parameterTypes: [], fields: []});
      assert.deepEqual((await client.script('BEGIN; ROLLBACK')).map(r => r.command), ['BEGIN','ROLLBACK']);
      assert.ok(driver.json(null));
      assert.ok(driver.param(['9007199254740993.25', null], driver.builtin.numericArray));
      await client.close();
      const pool = driver.createPool({host:'127.0.0.1',port:${server.port}});
      assert.deepEqual(pool.stats,{total:0,idle:0,leased:0,waiting:0});
      await pool.close();
    `,
      );
      await run(process.execPath, ['index.mjs'], { cwd: directory, timeout: 3000 });
      await writeFile(
        join(directory, 'index.ts'),
        `
      import { connect, createPool, builtin, defaultCodecs, json, param, sql, type Connection, type QueryResult, type PgArray } from '@kequtech/pgclear';
      async function example(connection: Connection) {
        const nested: PgArray<number> = [[1,null],[2,3]];
        await connection.query({text:'SELECT $1, $2',values:[param(nested,builtin.int4Array),json(null)]});
        defaultCodecs.with(builtin.jsonbText);
        // @ts-expect-error Typed array parameters require the codec's scalar type.
        param([[1.25]], builtin.numericArray);
        const result: QueryResult<{value: number}> = await connection.query<{value: number}>('SELECT 42 AS value');
        const count: bigint | null = result.rowCount;
        type Database = {user: {id:number; name:string; secret:string}};
        type Selected = Pick<Database['user'], 'id' | 'name'>;
        const tagged: QueryResult<Selected> = await connection.query(sql<Selected>\`SELECT id,name FROM users WHERE id=\${42}\`);
        const classic: QueryResult<Selected> = await connection.queryClassic<Selected>('SELECT id,name FROM users WHERE id=$1', [42]);
        const name: string | undefined = tagged.rows[0]?.name;
        // @ts-expect-error The tagged row type does not include secret.
        tagged.rows[0]?.secret;
        // @ts-expect-error Bare objects are not tag bind values.
        sql\`SELECT \${{name:'Ada'}}\`;
        // @ts-expect-error Undefined is not a classic bind value.
        connection.queryClassic('SELECT $1', [undefined]);
        const untyped = await connection.query(sql\`SELECT 1 AS value\`);
        const unknownValue: unknown = untyped.rows[0]!.value;
        // @ts-expect-error An unannotated tag leaves values unknown.
        const number: number = untyped.rows[0]!.value;
        // @ts-expect-error Assignment context cannot supply a row assertion missing from the tag.
        const contextual: QueryResult<Selected> = await connection.query(sql\`SELECT id,name FROM users\`);
        const array: QueryResult<readonly [number]> = await connection.queryClassic<readonly [number]>('SELECT $1::integer', [1], {rowMode:'array'});
        const tagArray: QueryResult<readonly [number]> = await connection.query(sql<readonly [number]>\`SELECT \${1}::integer\`, {rowMode:'array'});
        const untypedArray: QueryResult<readonly unknown[]> = await connection.query(sql\`SELECT \${1}::integer\`, {rowMode:'array'});
        // @ts-expect-error Untyped array-row values remain unknown.
        const untypedElement: number = untypedArray.rows[0]![0];
        void classic; void name; void array; void tagArray; void untypedArray; void unknownValue;
        const description = await connection.describe('SELECT $1::integer');
        const oid: number | undefined = description.parameterTypes[0];
        const script = await connection.script('SELECT 1; SELECT 2');
        // @ts-expect-error Preparation is not implemented or exported in M2.
        await connection.prepare('SELECT 42');
        const pool = createPool({maxConnections:2});
        await pool.transaction(async tx => {
          await tx.savepoint(async child => { await child.query('SELECT 1'); });
          // @ts-expect-error Transaction callbacks cannot release a lease.
          await tx.release();
        });
        const lease = await pool.acquire(); await lease.release();
        // @ts-expect-error Multi-statement scripts require a held session.
        await pool.script('SELECT 1; SELECT 2');
        await pool.close();
        void oid; void script;
        return {count, result};
      }
      void connect; void example;
    `,
      );
      await run(
        process.execPath,
        [
          join(root, 'node_modules/typescript/bin/tsc'),
          '--noEmit',
          '--strict',
          '--target',
          'ES2024',
          '--module',
          'NodeNext',
          '--types',
          'node',
          'index.ts',
        ],
        { cwd: directory, timeout: 10000 },
      );
    } finally {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
