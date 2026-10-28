import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeConfiguration } from '../src/config/index.js';
import { connect } from '../src/index.js';

test('URI precedence, escaping, IPv6, Unix sockets and fixed startup defaults', () => {
  const config = normalizeConfiguration({
    connectionString:
      'postgresql://u:p%40ss@[::1]:5433/db%20name?sslmode=require&application_name=uri',
    user: 'explicit',
    applicationName: 'override',
  });
  assert.equal(config.host, '::1');
  assert.equal(config.port, 5433);
  assert.equal(config.user, 'explicit');
  assert.equal(config.password, 'p@ss');
  assert.equal(config.database, 'db name');
  assert.equal(config.startup.application_name, 'override');
  assert.equal(config.startup.client_encoding, 'UTF8');
  assert.equal(config.startup.TimeZone, 'UTC');
  assert.deepEqual(config.tls, {});
  assert.equal(
    normalizeConfiguration('postgresql:///pgclear_test?host=%2Ftmp%2Fpg').host,
    '/tmp/pg',
  );
  assert.equal(
    normalizeConfiguration('postgresql:///pgclear_test?host=%2Ftmp%2F100%25').host,
    '/tmp/100%',
  );
});

test('invalid or unsupported configuration fails without including URI credentials in errors', async () => {
  const bad: unknown[] = [
    'postgresql://user:secret@host/db?unsupported=secret',
    'postgresql://user:secret@host/%zz',
    'http://user:secret@host/db',
    'postgresql://u:secret@host/db?sslmode=prefer',
    'postgresql:///pgclear_test?host=',
    'postgresql:///pgclear_test?port=',
    { host: '' },
    { host: null },
    { tls: null },
    { database: '' },
    { port: 0 },
    { port: 65536 },
    { password: 'x\0y' },
    { tls: { rejectUnauthorized: false } },
    { tls: { ca: [] } },
    { tls: { channelBinding: 'unknown' } },
    { startupParameters: { client_encoding: 'LATIN1' } },
    { startupParameters: { user: 'other' } },
    { unknown: true },
    { maxMessageBytes: 3 },
    { maxQueuedOperations: 0 },
    { connectTimeoutMs: -1 },
  ];
  for (const options of bad) {
    await assert.rejects(connect(options as never), (error) => {
      assert.equal((error as { code: string }).code, 'PGCLEAR_CONFIGURATION');
      assert.ok(!String(error).includes('secret'));
      assert.ok(!JSON.stringify(error).includes('secret'));
      return true;
    });
  }
});

test('already-aborted and zero-deadline startup never needs a reachable host', async () => {
  await assert.rejects(connect({ host: 'invalid.invalid' }, { signal: AbortSignal.abort() }), {
    code: 'PGCLEAR_ABORTED',
    outcome: 'not-sent',
  });
  await assert.rejects(connect({ host: 'invalid.invalid' }, { timeoutMs: 0 }), {
    code: 'PGCLEAR_TIMEOUT',
    outcome: 'not-sent',
  });
});
