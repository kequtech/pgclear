import { registerListener, notification } from './helpers/listener.js';
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
      const startup = await peer.startup();
      peer.socket.write(startupReady);
      if (startup.get('application_name') === 'packed_listener') {
        await registerListener(peer, ['packed']);
        peer.socket.write(notification('packed', 'package', 42));
        assert.equal((await peer.message()).type, 'X');
        peer.socket.end();
        return;
      }
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
      assert.equal((await peer.message()).type, 'P');
      assert.equal((await peer.message()).type, 'D');
      assert.equal((await peer.message()).type, 'S');
      peer.socket.write(
        Buffer.concat([packet('1'), packet('t', Buffer.from([0, 0])), packet('n'), ready]),
      );
      for (const type of ['B', 'D', 'E', 'S']) assert.equal((await peer.message()).type, type);
      peer.socket.write(
        Buffer.concat([packet('2'), packet('n'), packet('C', z('SELECT 1')), ready]),
      );
      assert.equal((await peer.message()).type, 'C');
      assert.equal((await peer.message()).type, 'S');
      peer.socket.write(Buffer.concat([packet('3'), ready]));
      for (const type of ['P', 'B', 'D', 'E', 'H']) assert.equal((await peer.message()).type, type);
      peer.socket.write(
        Buffer.concat([packet('1'), packet('2'), packet('n'), packet('C', z('SELECT 0'))]),
      );
      assert.equal((await peer.message()).type, 'S');
      peer.socket.write(ready);
      for (const direction of ['in', 'out']) {
        for (const type of ['P', 'B', 'D', 'E', 'H'])
          assert.equal((await peer.message()).type, type);
        peer.socket.write(
          Buffer.concat([
            packet('1'),
            packet('2'),
            packet('n'),
            packet(direction === 'in' ? 'G' : 'H', Buffer.from([0, 0, 0])),
          ]),
        );
        if (direction === 'in') {
          const data = await peer.message();
          assert.equal(data.type, 'd');
          assert.equal(data.payload.toString(), 'bytes');
          assert.equal((await peer.message()).type, 'c');
          assert.equal((await peer.message()).type, 'H');
          peer.socket.write(packet('C', z('COPY 1')));
        } else
          peer.socket.write(
            Buffer.concat([
              packet('d', Buffer.from('bytes')),
              packet('c'),
              packet('C', z('COPY 1')),
            ]),
          );
        assert.equal((await peer.message()).type, 'S');
        peer.socket.write(ready);
      }
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
      assert.deepEqual(
        archive!.files.filter((file) => file.path.startsWith('docs/')).map((file) => file.path),
        ['docs/public-api.md', 'docs/README.md'],
      );
      assert.ok(!archive!.files.some((file) => file.path.endsWith('.d.ts.map')));
      await mkdir(packagePath, { recursive: true });
      await run('tar', [
        '-xzf',
        join(directory, archive!.filename),
        '-C',
        packagePath,
        '--strip-components=1',
      ]);
      const manifest = JSON.parse(await readFile(join(packagePath, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>;
        private?: boolean;
        publishConfig?: { access?: string };
      };
      assert.notEqual(manifest.private, true);
      assert.equal(manifest.publishConfig?.access, 'public');
      assert.equal(Object.keys(manifest.dependencies ?? {}).length, 0);
      for (const file of archive!.files.filter((file) => file.path.endsWith('.js.map'))) {
        const map = JSON.parse(await readFile(join(packagePath, file.path), 'utf8')) as {
          sources: string[];
          sourcesContent: string[];
        };
        assert.equal(map.sourcesContent.length, map.sources.length);
        assert.ok(
          map.sourcesContent.every((source) => typeof source === 'string' && source.length),
        );
      }
      // Reuse installed dependencies, but only those actually declared by the packed manifest.
      for (const dependency of [...Object.keys(manifest.dependencies ?? {}), '@types/node']) {
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
      assert.deepEqual(Object.keys(driver).sort(), ['DatabaseError', 'DriverError', 'builtin', 'connect', 'createPool', 'defaultCodecs', 'generateDefinitions', 'json', 'listen', 'param', 'sql']);
      assert.deepEqual(driver.sql\`SELECT \${42}::integer AS value\`, ['SELECT $1::integer AS value', [42]]);
      const client = await driver.connect({host: '127.0.0.1', port: ${server.port}});
      assert.equal(client.info.backendPid, 123);
      assert.deepEqual(await client.describe('BEGIN'), {parameterTypes: [], fields: []});
      assert.deepEqual((await client.script('BEGIN; ROLLBACK')).map(r => r.command), ['BEGIN','ROLLBACK']);
      const prepared = await client.prepare('SELECT 1');
      assert.deepEqual(prepared.description, {parameterTypes:[], fields:[]});
      assert.equal((await prepared.query()).commandTag, 'SELECT 1');
      await prepared.close(); await prepared.close();
      await assert.rejects(prepared.query(), {code:'PGCLEAR_EXPIRED'});
      const stream = client.stream('SELECT 1 WHERE false', {batchSize:2});
      assert.deepEqual(await stream.fields, []);
      for await (const row of stream) assert.fail('Unexpected row');
      assert.deepEqual(await stream.completion, {status:'complete',result:{command:'SELECT',commandTag:'SELECT 0',rowCount:0n}});
      await stream.close();
      assert.deepEqual(await client.copyFrom('COPY fixture FROM STDIN', {async *[Symbol.asyncIterator](){yield Buffer.from('bytes');}}), {command:'COPY',commandTag:'COPY 1',rowCount:1n});
      const copy = client.copyTo('COPY fixture TO STDOUT');
      const chunks=[];for await(const chunk of copy)chunks.push(chunk);assert.equal(Buffer.concat(chunks).toString(),'bytes');
      assert.equal((await copy.completion).status,'complete');await copy.close();
      assert.ok(driver.json(null));
      assert.ok(driver.param(['9007199254740993.25', null], driver.builtin.numericArray));
      await client.close();
      const notified=Promise.withResolvers();
      const listener=await driver.listen({host:'127.0.0.1',port:${server.port},applicationName:'packed_listener'},
        {channels:['packed'],timeoutMs:3600000,onNotification:notified.resolve});
      assert.equal(listener.status.state,'connected');
      assert.deepEqual(await notified.promise,{channel:'packed',payload:'package',backendPid:42});
      const closing=listener.close();assert.equal(listener.close(),closing);await closing;
      assert.equal(listener.status.state,'closed');
      const pool = driver.createPool({host:'127.0.0.1',port:${server.port}});
      assert.deepEqual(pool.stats,{total:0,idle:0,leased:0,waiting:0});
      await pool.close();
    `,
      );
      await run(process.execPath, ['index.mjs'], { cwd: directory, timeout: 3000 });
      await writeFile(
        join(directory, 'index.ts'),
        `
      import { connect, createPool, listen, generateDefinitions, type GenerateOptions, type Notification, type Listener, type ListenerStatus, type ListenerOptions, builtin, defaultCodecs, json, param, sql, type Connection, type QueryResult, type PgArray, type PreparedStatement, type PreparingExecutor, type RowStream, type StreamingExecutor, type StreamOptions, type ArrayStreamOptions, type StreamCompletion, type CommandResult, type CopySource, type CopyStream, type CopyingExecutor } from '@kequtech/pgclear';
      async function example(connection: Connection) {
        const generationOptions:GenerateOptions={connection,namespace:'public',timeoutMs:1000};
        const definitions:string=await generateDefinitions(generationOptions);
        // @ts-expect-error generation requires a connection source
        generateDefinitions({namespace:'public'});
        const listenerOptions: ListenerOptions={channels:['jobs'],reconnect:true,onNotification(value){const n:Notification=value;
          const channel:string=n.channel; const pid:number=n.backendPid;
          // @ts-expect-error notification payloads are opaque strings
          const parsed:object=n.payload;
        },onStatus(status){if(status.state==='connected'){const generation:number=status.generation;const pid:number=status.session.backendPid;}}};
        const listener:Listener=await listen({host:'localhost'},listenerOptions);
        const status:ListenerStatus=listener.status;await listener.close();
        // @ts-expect-error channel registrations are required
        listen({host:'localhost'},{onNotification(){}});
        // @ts-expect-error notifications require a callback
        listen({host:'localhost'},{channels:['jobs']});

        const nested: PgArray<number> = [[1,null],[2,3]];
        await connection.queryClassic('SELECT $1, $2',[param(nested,builtin.int4Array),json(null)]);
        defaultCodecs.with(builtin.jsonbText);
        // @ts-expect-error Typed array parameters require the codec's scalar type.
        param([[1.25]], builtin.numericArray);
        const result: QueryResult<{value: number}> = await connection.queryClassic<{value: number}>('SELECT 42 AS value', []);
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
        const preparing: PreparingExecutor = connection;
        const prepared: PreparedStatement = await preparing.prepare('SELECT $1::integer AS n');
        const preparedObject: QueryResult<{n:number}> = await prepared.query<{n:number}>([42]);
        const preparedArray: QueryResult<readonly [number]> = await prepared.query<readonly [number]>([42], {rowMode:'array'});
        const preparedUnknown = await prepared.query([42]);
        // @ts-expect-error Unannotated prepared rows leave values unknown.
        const preparedNumber: number = preparedUnknown.rows[0]!.n;
        // @ts-expect-error Bind values retain strict input typing.
        await prepared.query([undefined]);
        // @ts-expect-error Only object and array row modes are supported.
        await prepared.query([42], {rowMode:'tuple'});
        // @ts-expect-error Preparation accepts SQL and OIDs, not execution values.
        await connection.prepare({text:'SELECT $1',values:[1]});
        await prepared.close();
        void preparedObject; void preparedArray;
        const streaming: StreamingExecutor = connection;
        const streamOptions: StreamOptions = {batchSize:2};
        const arrayStreamOptions: ArrayStreamOptions = {batchSize:2,rowMode:'array'};
        const stream: RowStream<Selected> = streaming.stream(sql<Selected>\`SELECT id,name FROM users\`,streamOptions);
        const arrayStream: RowStream<readonly [number]> = connection.stream(sql<readonly [number]>\`SELECT 1\`,arrayStreamOptions);
        const unknownStream = connection.stream(sql\`SELECT 1 AS n\`);
        for await (const row of unknownStream) {
          // @ts-expect-error Unannotated stream row values stay unknown.
          const n: number = row.n;
        }
        // @ts-expect-error Assignment context cannot assert an unannotated tag's stream row.
        const contextualStream: RowStream<Selected> = connection.stream(sql\`SELECT id,name FROM users\`);
        const unknownArrayStream = connection.stream('SELECT 1',arrayStreamOptions);
        for await (const row of unknownArrayStream) {
          // @ts-expect-error Unannotated array stream elements stay unknown.
          const n: number = row[0];
        }
        const completion: StreamCompletion = await stream.completion;
        if(completion.status==='complete') { const count: bigint|null=completion.result.rowCount; void count; }
        else {
          // @ts-expect-error Early close has no invented final command or count.
          completion.result;
        }
        // @ts-expect-error Only object and array modes are supported.
        connection.stream('SELECT 1',{rowMode:'tuple'});
        void arrayStream;
        const copying: CopyingExecutor = connection;
        const source: CopySource = {async *[Symbol.asyncIterator](){yield new Uint8Array([1,2]);}};
        const copied: CommandResult = await copying.copyFrom('COPY fixture FROM STDIN',source);
        const copy: CopyStream = connection.copyTo('COPY fixture TO STDOUT');
        for await(const chunk of copy) {const bytes:Uint8Array=chunk;void bytes;}
        await connection.copyFrom('COPY fixture FROM STDIN',(await import('node:stream')).Readable.from([new Uint8Array([1])]));
        // @ts-expect-error COPY input chunks must be bytes.
        connection.copyFrom('COPY fixture FROM STDIN',{async *[Symbol.asyncIterator](){yield 'text';}});
        // @ts-expect-error COPY takes one SQL text statement, with no query tuple or values.
        connection.copyTo(sql\`COPY fixture TO STDOUT\`);
        // @ts-expect-error COPY options cannot request row decoding.
        connection.copyTo('COPY fixture TO STDOUT',{rowMode:'array'});
        void copied;
        const pool = createPool({maxConnections:2});
        await pool.transaction(async tx => {
          for await (const row of tx.stream('SELECT 1')) { void row; }
          const source={async *[Symbol.asyncIterator](){yield new Uint8Array();}};
          await tx.copyFrom('COPY fixture FROM STDIN',source);
          for await (const chunk of tx.copyTo('COPY fixture TO STDOUT')) {void chunk;}
          const owned = await tx.prepare('SELECT 1'); await owned.close();
          await tx.savepoint(async child => { await child.queryClassic('SELECT 1', []); const p = await child.prepare('SELECT 1'); await p.close(); });
          // @ts-expect-error Transaction callbacks cannot release a lease.
          await tx.release();
        });
        const lease = await pool.acquire(); await lease.release();
        // @ts-expect-error COPY requires an explicitly owned scope.
        pool.copyTo('COPY fixture TO STDOUT');
        // @ts-expect-error Streaming requires an explicitly owned scope.
        pool.stream('SELECT 1');
        // @ts-expect-error Named preparation requires an explicitly owned scope.
        await pool.prepare('SELECT 1');
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
