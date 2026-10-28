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
      assert.deepEqual(Object.keys(driver).sort(), ['DatabaseError', 'DriverError', 'builtin', 'connect', 'defaultCodecs', 'json', 'param']);
      const client = await driver.connect({host: '127.0.0.1', port: ${server.port}});
      assert.equal(client.info.backendPid, 123);
      assert.deepEqual(await client.describe('BEGIN'), {parameterTypes: [], fields: []});
      assert.deepEqual((await client.script('BEGIN; ROLLBACK')).map(r => r.command), ['BEGIN','ROLLBACK']);
      assert.ok(driver.json(null));
      assert.ok(driver.param(['9007199254740993.25', null], driver.builtin.numericArray));
      await client.close();
    `,
      );
      await run(process.execPath, ['index.mjs'], { cwd: directory, timeout: 3000 });
      await writeFile(
        join(directory, 'index.ts'),
        `
      import { connect, builtin, defaultCodecs, json, param, type Connection, type QueryResult, type PgArray } from '@kequtech/pgclear';
      async function example(connection: Connection) {
        const nested: PgArray<number> = [[1,null],[2,3]];
        await connection.query({text:'SELECT $1, $2',values:[param(nested,builtin.int4Array),json(null)]});
        defaultCodecs.with(builtin.jsonbText);
        // @ts-expect-error Typed array parameters require the codec's scalar type.
        param([[1.25]], builtin.numericArray);
        const result: QueryResult<{value: number}> = await connection.query<{value: number}>('SELECT 42 AS value');
        const count: bigint | null = result.rowCount;
        const description = await connection.describe('SELECT $1::integer');
        const oid: number | undefined = description.parameterTypes[0];
        const script = await connection.script('SELECT 1; SELECT 2');
        // @ts-expect-error Preparation is not implemented or exported in M2.
        await connection.prepare('SELECT 42');
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
