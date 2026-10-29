import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, copyFile, chmod, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { connect, type ConnectionOptions } from '../../src/index.js';

const run = promisify(execFile);
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('No test port allocated.');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

/** Disposable TLS/Unix/proxy fixture. Never edits or stops the configured PostgreSQL installation. */
export async function compatibilityServer() {
  const binary = process.env.PGCLEAR_PGBOUNCER;
  if (!binary) throw Error('PGCLEAR_PGBOUNCER must point to the pinned test binary.');
  const pin = JSON.parse(await readFile(resolve('test/compatibility/pgbouncer.json'), 'utf8')) as {
    version: string;
  };
  const version = (await run(binary, ['--version'])).stdout;
  if (!version.startsWith('PgBouncer ' + pin.version + '\n'))
    throw Error('PgBouncer differs from the test pin.');
  const bindir =
    process.env.PGCLEAR_POSTGRES_BIN ?? (await run('pg_config', ['--bindir'])).stdout.trim();
  const root = await mkdtemp(join(tmpdir(), 'pgclear-compat-'));
  const data = join(root, 'data');
  let postgres = false;
  let proxy: ReturnType<typeof spawn> | undefined;
  let logs = '';
  async function close() {
    const errors: unknown[] = [];
    if (proxy) {
      const child = proxy;
      // Foreground PgBouncer owns no detached processes. SIGKILL keeps failed tests bounded.
      child.kill('SIGKILL');
      if (child.exitCode === null && child.signalCode === null)
        await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      proxy = undefined;
    }
    if (postgres) {
      try {
        await run(join(bindir, 'pg_ctl'), ['-D', data, '-m', 'immediate', '-w', '-t', '5', 'stop']);
      } catch (error) {
        errors.push(error);
      }
      postgres = false;
    }
    if (errors.length === 0) await rm(root, { recursive: true, force: true });
    if (errors.length) throw new AggregateError(errors, 'Compatibility fixture cleanup failed.');
  }
  try {
    const password = join(root, 'password');
    await writeFile(password, 'postgres\n', { mode: 0o600 });
    await copyFile(resolve('test/fixtures/server-cert.pem'), join(root, 'server.crt'));
    await copyFile(resolve('test/fixtures/server-key.pem'), join(root, 'server.key'));
    await chmod(join(root, 'server.key'), 0o600);
    await run(
      join(bindir, 'initdb'),
      [
        '-D',
        data,
        '-U',
        'postgres',
        '--pwfile=' + password,
        '--auth-host=scram-sha-256',
        '--auth-local=scram-sha-256',
        '--no-locale',
        '--encoding=UTF8',
      ],
      { timeout: 20000 },
    );
    const port = await freePort();
    await writeFile(
      join(data, 'postgresql.conf'),
      `listen_addresses='127.0.0.1'
port=${port}
unix_socket_directories='${root}'
ssl=on
ssl_cert_file='${root}/server.crt'
ssl_key_file='${root}/server.key'
max_connections=100
`,
    );
    postgres = true; // Cleanup also covers a partially successful start.
    await run(
      join(bindir, 'pg_ctl'),
      ['-D', data, '-l', join(root, 'postgres.log'), '-w', '-t', '10', 'start'],
      { timeout: 15000 },
    );
    const ca = await readFile(join(root, 'server.crt'), 'utf8');
    const options: ConnectionOptions = {
      host: '127.0.0.1',
      port,
      user: 'postgres',
      password: 'postgres',
      database: 'postgres',
      tls: { ca, serverName: 'localhost', channelBinding: 'require' },
    };
    const admin = await connect(options);
    try {
      await admin.query('CREATE DATABASE pgclear_test');
    } finally {
      await admin.close();
    }
    const direct = { ...options, database: 'pgclear_test' };
    const proxyPort = await freePort();
    await writeFile(join(root, 'users.txt'), '"postgres" "postgres"\n', { mode: 0o600 });
    const config = join(root, 'pgbouncer.ini');
    await writeFile(
      config,
      `[databases]
session_test = host=127.0.0.1 port=${port} dbname=pgclear_test user=postgres password=postgres pool_mode=session
transaction_test = host=127.0.0.1 port=${port} dbname=pgclear_test user=postgres password=postgres pool_mode=transaction

[pgbouncer]
listen_addr = 127.0.0.1
listen_port = ${proxyPort}
unix_socket_dir = ${root}
auth_type = scram-sha-256
auth_file = ${root}/users.txt
admin_users = postgres
default_pool_size = 2
max_client_conn = 30
max_prepared_statements = 0
client_tls_sslmode = require
client_tls_cert_file = ${root}/server.crt
client_tls_key_file = ${root}/server.key
server_tls_sslmode = verify-full
server_tls_ca_file = ${root}/server.crt
log_connections = 0
log_disconnections = 0
`,
      { mode: 0o600 },
    );
    proxy = spawn(binary, [config], { stdio: ['ignore', 'ignore', 'pipe'] });
    let failure: Error | undefined;
    proxy.on('error', (error) => {
      failure = error;
    });
    proxy.stderr?.on('data', (chunk: Buffer) => {
      logs = (logs + chunk.toString()).slice(-16000);
    });
    const session = {
      ...direct,
      port: proxyPort,
      database: 'session_test',
      tls: { ca, serverName: 'localhost' },
    };
    const end = performance.now() + 5000;
    for (;;) {
      if (failure) throw failure;
      if (proxy.exitCode !== null || proxy.signalCode !== null)
        throw Error('PgBouncer exited: ' + logs);
      try {
        const client = await connect(session, { timeoutMs: 250 });
        await client.close();
        break;
      } catch (error) {
        if (performance.now() > end)
          throw new Error('PgBouncer did not become ready: ' + logs, { cause: error });
      }
      await pause(20);
    }
    return {
      direct,
      unix: { ...direct, host: root, tls: false as const },
      session,
      transaction: { ...session, database: 'transaction_test' },
      close,
      version: pin.version,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Compatibility setup and cleanup failed.');
    }
    throw error;
  }
}
