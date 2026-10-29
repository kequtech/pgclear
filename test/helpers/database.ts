import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connect, type ConnectionOptions } from '../../src/index.js';

export function databaseUrl(): string {
  const value = process.env.PGCLEAR_TEST_DATABASE_URL;
  if (!value) throw new Error('PGCLEAR_TEST_DATABASE_URL is required for integration tests.');
  const url = new URL(value);
  const name = decodeURIComponent(url.pathname.slice(1));
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !name.endsWith('_test') ||
    url.searchParams.has('dbname')
  ) {
    throw new Error('Integration tests require an explicit _test database in the URL path.');
  }
  return value;
}

export function ownedName(): string {
  return 'pgclear_test_' + randomUUID().replaceAll('-', '');
}

export async function testConnection(options: ConnectionOptions = {}) {
  const url = databaseUrl(),
    applicationName = ownedName();
  const client = await connect({ connectionString: url, applicationName, ...options });
  try {
    const result = await client.queryClassic<{ database: string }>(
      'SELECT current_database() AS database',
      [],
    );
    assert.equal(result.rows[0]!.database, decodeURIComponent(new URL(url).pathname.slice(1)));
    return { client, applicationName };
  } catch (error) {
    await client.close({ timeoutMs: 0 });
    throw error;
  }
}
