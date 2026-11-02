import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DriverError, findDriverErrors } from '../src/index.js';

test('error inspection preserves each operation’s original evidence through causes and aggregates', () => {
  const commit = new DriverError('PGCLEAR_COMMIT_UNKNOWN', 'lost response', 'unknown');
  const cleanup = new DriverError('PGCLEAR_CONNECTION_LOST', 'cleanup', 'confirmed');
  const root = new AggregateError(
    [new Error('work', { cause: commit }), cleanup, commit],
    'failed',
  );
  assert.deepEqual(findDriverErrors(root), [commit, cleanup]);
  assert.equal(findDriverErrors(root)[0], commit);
  assert.equal(commit.outcome, 'unknown');
  assert.equal(cleanup.outcome, 'confirmed');
  assert.deepEqual(findDriverErrors(new Error('ordinary')), []);
});

test('inspection handles cyclic/shared graphs and non-Error causes without reading getters', () => {
  const driver = new DriverError('PGCLEAR_TIMEOUT', 'statement', 'unknown');
  const cause = { cause: driver };
  const root = new AggregateError([cause, null, 3, undefined], 'failed', { cause });
  Object.defineProperty(driver, 'cause', { value: root });
  assert.deepEqual(findDriverErrors(root), [driver]);
  let reads = 0;
  const accessor = Object.defineProperty({}, 'cause', {
    get() {
      reads++;
      throw new Error('getter');
    },
  });
  assert.deepEqual(findDriverErrors(accessor), []);
  assert.equal(reads, 0);
  for (const value of [undefined, null, 42, 'failure'])
    assert.deepEqual(findDriverErrors(value), []);
});

test('deep cause chains are inspected iteratively', () => {
  const driver = new DriverError('PGCLEAR_ABORTED', 'cancelled');
  let root: unknown = driver;
  for (let index = 0; index < 20000; index++) root = { cause: root };
  assert.deepEqual(findDriverErrors(root), [driver]);
});
