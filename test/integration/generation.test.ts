import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  builtin,
  createPool,
  defaultCodecs,
  generateDefinitions,
  json,
  param,
  type Connection,
} from '../../src/index.js';
import { databaseUrl, ownedName, testConnection } from '../helpers/database.js';
import { checkGenerated, typeAssertions } from '../helpers/generation.js';

const within = { timeout: 15000 };
const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
async function fixture(work: (client: Connection, namespace: string) => Promise<void>) {
  const { client } = await testConnection();
  const namespace = ownedName();
  await client.query(`CREATE SCHEMA ${quote(namespace)}`);
  try {
    await work(client, namespace);
  } finally {
    try {
      await client.query(`DROP SCHEMA ${quote(namespace)} CASCADE`);
    } finally {
      await client.close();
    }
  }
}

test(
  'generated Database rows and mutation shapes match native values, defaults and explicit binds',
  within,
  async () => {
    await fixture(async (client, namespace) => {
      const ns = quote(namespace);
      await client.script(`
      CREATE TYPE ${ns}.role AS ENUM ('member','admin');
      CREATE TABLE ${ns}.users(
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        name text NOT NULL,
        role ${ns}.role NOT NULL DEFAULT 'member',
        active boolean NOT NULL DEFAULT true,
        balance numeric NOT NULL DEFAULT 0,
        big bigint, at timestamptz, tags text[], document jsonb, bytes bytea,
        folded text GENERATED ALWAYS AS (lower(name)) STORED
      );
      CREATE UNIQUE INDEX users_name_index ON ${ns}.users(lower(name)) WHERE active;
      CREATE TABLE ${ns}.posts(id integer PRIMARY KEY, user_id integer REFERENCES ${ns}.users(id), title text NOT NULL);
    `);
      const source = await generateDefinitions({ connection: client, namespace });
      assert.match(source, /^\/\/\s+CONSTRAINT.*FOREIGN KEY.*REFERENCES users\(id\)/m);
      assert.match(source, /^\/\/\s+CREATE UNIQUE INDEX users_name_index ON users /m);
      await checkGenerated(
        source,
        `
      import type { Database } from './schema.js';
      import { builtin, json, param, type Connection, type PgArray } from '@kequtech/pgclear';
      ${typeAssertions}
      type Tables = Assert<Equal<keyof Database, 'users' | 'posts'>>;
      type Shapes = Assert<Equal<keyof Database['users'], 'row' | 'insert' | 'update'>>;
      declare const row: Database['users']['row'];
      const id: number = row.id;
      const big: bigint | null = row.big;
      const balance: string = row.balance;
      const at: string | null = row.at;
      const tags: PgArray<string> | null = row.tags;
      const bytes: Uint8Array | null = row.bytes;
      const role: 'member' | 'admin' = row.role;
      const document: unknown = row.document;
      const insert: Database['users']['insert'] = { name: 'Alice', tags: param(['x'], builtin.textArray), document: json({ok:true}) };
      const update: Database['users']['update'] = { active: false, name: undefined };
      // @ts-expect-error a required column without a default cannot be omitted
      const missing: Database['users']['insert'] = {};
      // @ts-expect-error GENERATED ALWAYS identity is not writable
      const identity: Database['users']['insert'] = { name: 'x', id: 1 };
      // @ts-expect-error expression-generated columns are not writable
      const generated: Database['users']['update'] = { folded: 'x' };
      // @ts-expect-error ordinary binds require explicit array parameters
      const bareArray: Database['users']['insert'] = { name: 'x', tags: ['x'] };
      // @ts-expect-error bare objects are not JSON parameters
      const bareJson: Database['users']['insert'] = { name: 'x', document: {ok:true} };
      // @ts-expect-error relationships are comments, not extra row properties
      type Relation = Database['posts']['row']['user'];
      async function write(connection: Connection) {
        const value: Database['users']['insert'] = {name:'x', big:42n};
        await connection.queryClassic('INSERT INTO users(name,big) VALUES($1,$2)', [value.name, value.big!]);
      }
    `,
      );
      const row = (
        await client.queryClassic(
          `INSERT INTO ${ns}.users(name,big,at,tags,document,bytes) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
          [
            'Alice',
            9007199254740993n,
            'infinity',
            param(['x', null], builtin.textArray),
            json({ ok: true }),
            new Uint8Array([0, 255]),
          ],
        )
      ).rows[0]!;
      assert.equal(row.big, 9007199254740993n);
      assert.equal(row.balance, '0');
      assert.equal(row.at, 'infinity');
      assert.equal(row.role, 'member');
      assert.deepEqual(row.tags, ['x', null]);
      assert.deepEqual(row.document, { ok: true });
      assert.deepEqual(row.bytes, new Uint8Array([0, 255]));
      assert.equal(row.folded, 'alice');
    });
  },
);

test(
  'generation follows domains and stable array codecs while keeping dynamic types as wire text',
  within,
  async () => {
    await fixture(async (client, namespace) => {
      const ns = quote(namespace);
      await client.script(`
      CREATE DOMAIN ${ns}.required AS integer NOT NULL DEFAULT 7;
      CREATE DOMAIN ${ns}.outer_required AS ${ns}.required;
      CREATE DOMAIN ${ns}.decimals AS numeric[];
      CREATE TYPE ${ns}.mood AS ENUM ('a','b');
      CREATE TYPE ${ns}.empty AS ENUM ();
      CREATE TABLE ${ns}.values(id ${ns}.outer_required, decimals ${ns}.decimals NOT NULL,
        times timestamptz[], names name[], enums ${ns}.mood[], domains ${ns}.required[],
        ranges int4range[], point point, empty ${ns}.empty);
      CREATE TABLE ${ns}.root(id int) PARTITION BY RANGE(id);
      CREATE TABLE ${ns}.leaf PARTITION OF ${ns}.root FOR VALUES FROM(0) TO(10);
      CREATE VIEW ${ns}.view AS SELECT 1 AS value;
    `);
      const source = await generateDefinitions({ connection: client, namespace });
      await checkGenerated(
        source,
        `
      import type { Database } from './schema.js';
      import type { PgArray } from '@kequtech/pgclear';
      ${typeAssertions}
      type Tables = Assert<Equal<keyof Database, 'values' | 'root'>>;
      declare const row: Database['values']['row'];
      const id: number | null = row.id;
      const decimals: PgArray<string> = row.decimals;
      const times: PgArray<string> | null = row.times;
      const names: PgArray<string> | null = row.names;
      const enums: string | null = row.enums;
      const domains: string | null = row.domains;
      const ranges: PgArray<string> | null = row.ranges;
      const point: string | null = row.point;
      const empty: null = row.empty;
      const insert: Database['values']['insert'] = {decimals:'{}'};
      // @ts-expect-error the domain NOT NULL constraint applies to supplied inputs
      const bad: Database['values']['insert'] = {id:null,decimals:'{}'};
    `,
      );
      const row = (
        await client.query(
          `INSERT INTO ${ns}.values(decimals,times,names,enums,domains,ranges,point) VALUES('{}',ARRAY['infinity'::timestamptz],ARRAY['hello'::name],ARRAY['a'::${ns}.mood],ARRAY[8::${ns}.required],ARRAY['[1,3)'::int4range],point(1,2)) RETURNING *`,
        )
      ).rows[0]!;
      assert.equal(row.id, 7);
      assert.deepEqual(row.times, ['infinity']);
      assert.deepEqual(row.names, ['hello']);
      assert.equal(row.enums, '{a}');
      assert.equal(row.domains, '{8}');
      assert.deepEqual(row.ranges, ['[1,3)']);
      assert.equal(row.point, '(1,2)');
    });
  },
);

test(
  'catalog reads ignore application overrides while generated rows reflect the selected decoders',
  within,
  async () => {
    await fixture(async (client, namespace) => {
      await client.query(
        `CREATE TABLE ${quote(namespace)}.custom(id integer, label text, flag boolean, numbers integer[], document jsonb)`,
      );
      const codecs = defaultCodecs
        .with({ oid: 23, text: { encode: String, decode: (value: string) => 'int:' + value } })
        .with({ oid: 25, text: { encode: String, decode: (value: string) => 'text:' + value } })
        .with({
          oid: 16,
          text: { encode: String, decode: (value: string) => (value === 't' ? 'yes' : 'no') },
        })
        .with(builtin.jsonbText);
      const pool = createPool({ connectionString: databaseUrl(), codecs, maxConnections: 1 });
      const warnings: string[] = [];
      try {
        const source = await generateDefinitions({
          connection: pool,
          namespace,
          onWarning: async (message) => {
            warnings.push(message);
          },
        });
        assert.equal(warnings.length, 4);
        await checkGenerated(
          source,
          `
        import type { Database } from './schema.js';
        ${typeAssertions}
        type Id = Assert<Equal<Database['custom']['row']['id'],unknown>>;
        type Label = Assert<Equal<Database['custom']['row']['label'],unknown>>;
        type Flag = Assert<Equal<Database['custom']['row']['flag'],unknown>>;
        type Numbers = Assert<Equal<Database['custom']['row']['numbers'],unknown>>;
        declare const row: Database['custom']['row'];
        const document:string|null=row.document;
      `,
        );
        assert.deepEqual((await pool.query("SELECT 42 AS n,true AS b,'value'::text AS t")).rows, [
          { n: 'int:42', b: 'yes', t: 'text:value' },
        ]);
        await assert.rejects(
          generateDefinitions({
            connection: pool,
            namespace,
            onWarning() {
              throw Error('stop generation');
            },
          }),
          /stop generation/,
        );
        assert.equal((await pool.query('SELECT 1 AS n')).rows[0]!.n, 'int:1');
      } finally {
        await pool.close();
      }
      const arrays = createPool({
        connectionString: databaseUrl(),
        codecs: codecs.with(builtin.int4Array),
      });
      try {
        const source = await generateDefinitions({ connection: arrays, namespace, onWarning() {} });
        await checkGenerated(
          source,
          `import type {Database} from './schema.js'; import type {PgArray} from '@kequtech/pgclear'; declare const row:Database['custom']['row']; const numbers:PgArray<number>|null=row.numbers;`,
        );
      } finally {
        await arrays.close();
      }
    });
  },
);

test(
  'generation preserves borrowed session settings, excludes only requested tables and releases failures',
  within,
  async () => {
    await fixture(async (client, namespace) => {
      const ns = quote(namespace);
      await client.script(
        `CREATE TABLE ${ns}.kept(id int); CREATE TABLE ${ns}."skip,quoted"(id int); CREATE TABLE ${ns}.__tenon_migrations(id int);`,
      );
      await client.query(`SET search_path TO ${ns},pg_catalog`);
      await client.query('SET quote_all_identifiers TO on');
      const before = (
        await client.query(
          "SELECT current_setting('search_path') AS path,current_setting('quote_all_identifiers') AS quoted,pg_backend_pid() AS pid",
        )
      ).rows;
      const source = await generateDefinitions({
        connection: client,
        namespace,
        excludeTables: ['skip,quoted'],
      });
      await checkGenerated(
        source,
        `import type {Database} from './schema.js'; ${typeAssertions} type Tables=Assert<Equal<keyof Database,'kept'|'__tenon_migrations'>>;`,
      );
      await assert.rejects(
        generateDefinitions({ connection: client, namespace: namespace + '_missing' }),
        /does not exist/,
      );
      assert.equal(client.transactionStatus, 'idle');
      assert.deepEqual(
        (
          await client.query(
            "SELECT current_setting('search_path') AS path,current_setting('quote_all_identifiers') AS quoted,pg_backend_pid() AS pid",
          )
        ).rows,
        before,
      );
    });
  },
);

test(
  'quoted names and multiline catalog definitions remain data and comments in generated TypeScript',
  within,
  async () => {
    await fixture(async (client, namespace) => {
      const table = 'odd"\nexport const injected=1;\u2028*/';
      const column = '__proto__\r\n\u2029';
      await client.query(
        `CREATE TABLE ${quote(namespace)}.${quote(table)}(${quote(column)} text DEFAULT E'a\nb')`,
      );
      const source = await generateDefinitions({ connection: client, namespace });
      await checkGenerated(
        source,
        `
      import type {Database} from './schema.js';
      ${typeAssertions}
      type Tables=Assert<Equal<keyof Database,${JSON.stringify(table)}>>;
      declare const row:Database[${JSON.stringify(table)}]['row'];
      const value:string|null=row[${JSON.stringify(column)}];
      // @ts-expect-error catalog text must not create executable exports
      import {injected} from './schema.js';
    `,
      );
    });
  },
);

test(
  'empty schemas are valid and owned generation closes sockets and long deadlines on success or failure',
  within,
  async () => {
    await fixture(async (client, namespace) => {
      const applicationName = ownedName();
      const options = {
        connection: { connectionString: databaseUrl(), applicationName },
        namespace,
        timeoutMs: 3600000,
      };
      const source = await generateDefinitions(options);
      await checkGenerated(
        source,
        `import type {Database} from './schema.js'; ${typeAssertions} type Empty=Assert<Equal<keyof Database,never>>;`,
      );
      await assert.rejects(
        generateDefinitions({ ...options, namespace: namespace + '_missing' }),
        /does not exist/,
      );
      assert.equal(
        (
          await client.queryClassic(
            'SELECT count(*) AS n FROM pg_stat_activity WHERE application_name=$1',
            [applicationName],
          )
        ).rows[0]!.n,
        0n,
      );
    });
  },
);

test(
  'a generation deadline waiting for a lease leaves earlier work and the borrowed pool usable',
  within,
  async () => {
    await fixture(async (_client, namespace) => {
      const pool = createPool({ connectionString: databaseUrl(), maxConnections: 1 });
      const held = await pool.acquire();
      try {
        const work = held.query('SELECT pg_sleep(0.04),1 AS n');
        await assert.rejects(generateDefinitions({ connection: pool, namespace, timeoutMs: 5 }), {
          code: 'PGCLEAR_TIMEOUT',
          outcome: 'not-sent',
        });
        assert.equal((await work).rows[0]!.n, 1);
        await held.release();
        await generateDefinitions({ connection: pool, namespace });
      } finally {
        await held.release();
        await pool.close();
      }
    });
  },
);

test(
  'abort settles generation while an asynchronous warning is pending and leaves its pool usable',
  within,
  async () => {
    await fixture(async (client, namespace) => {
      await client.query(`CREATE TABLE ${quote(namespace)}.custom(id integer)`);
      const codecs = defaultCodecs.with({
        oid: 23,
        text: { encode: String, decode: (value: string) => 'int:' + value },
      });
      const pool = createPool({ connectionString: databaseUrl(), maxConnections: 1, codecs });
      const entered = Promise.withResolvers<void>();
      const controller = new AbortController();
      const work = generateDefinitions({
        connection: pool,
        namespace,
        signal: controller.signal,
        onWarning() {
          entered.resolve();
          return new Promise<void>(() => {});
        },
      });
      const rejected = assert.rejects(work, (error: unknown) => {
        const errors: unknown[] = [error];
        while (errors.length) {
          const current = errors.pop();
          if (
            current &&
            typeof current === 'object' &&
            'code' in current &&
            current.code === 'PGCLEAR_ABORTED'
          )
            return true;
          if (current instanceof AggregateError) errors.push(...current.errors);
          if (current instanceof Error && current.cause) errors.push(current.cause);
        }
        return false;
      });
      try {
        await entered.promise;
        controller.abort();
        await rejected;
        assert.equal((await pool.query('SELECT 1 AS n')).rows[0]!.n, 'int:1');
      } finally {
        controller.abort();
        await pool.close();
      }
    });
  },
);
