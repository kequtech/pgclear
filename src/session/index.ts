import type { PhysicalConnection } from '../connection/index.js';
import { abortError, deadline, Lifetime } from '../connection/timing.js';
import { validateOperation } from '../config/index.js';
import { DriverError } from '../errors.js';
import type {
  ArrayQueryOptions,
  CloseOptions,
  Connection,
  DescribeStatement,
  Description,
  OperationOptions,
  QueryOptions,
  QueryResult,
  Row,
  Session,
  Statement,
  Transaction,
  TransactionOptions,
} from '../types.js';

const expired = () => new DriverError('PGCLEAR_EXPIRED', 'This session scope has expired.');
const busy = () => new DriverError('PGCLEAR_BUSY', 'A child scope owns this session.');
const state = () =>
  new DriverError(
    'PGCLEAR_TRANSACTION_STATE',
    'Unexpected PostgreSQL transaction state.',
    'confirmed',
  );
function combined(errors: unknown[]): unknown {
  return errors.length === 1
    ? errors[0]
    : new AggregateError(errors, 'Work and session cleanup failed.');
}

/** A capability is never reactivated. Every checkout and child scope creates a new one. */
export class Scope {
  active = true;
  child: Scope | undefined;
  poisoned = false;
  cleanupDeadline: number | undefined;
  readonly expiry = new AbortController();
  readonly pending = new Set<Promise<unknown>>();
  readonly #initialDispatches: number;
  constructor(
    readonly connection: PhysicalConnection,
    readonly lifetime?: Lifetime,
  ) {
    this.#initialDispatches = connection.dispatchCount;
  }
  interruption(error: DriverError): DriverError {
    return new DriverError(
      error.code,
      error.message,
      this.connection.dispatchCount > this.#initialDispatches ? 'unknown' : 'not-sent',
      { cause: error },
    );
  }
  get signal(): AbortSignal | undefined {
    return this.lifetime?.signal;
  }
  check(): void {
    if (!this.active)
      throw this.expiry.signal.reason instanceof DriverError &&
        this.expiry.signal.reason.code === 'PGCLEAR_CLOSED'
        ? this.expiry.signal.reason
        : expired();
    if (!this.connection.usable)
      throw new DriverError('PGCLEAR_CLOSED', 'The physical session is closed.');
    if (this.child) throw busy();
    this.lifetime?.check();
  }
  expire(reason: unknown = expired()): void {
    if (!this.active) return;
    this.active = false;
    this.child?.expire(reason);
    this.expiry.abort(reason);
  }
  track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    void promise.then(
      () => this.pending.delete(promise),
      () => this.pending.delete(promise),
    );
    return promise;
  }
  drain(): Promise<unknown> {
    return Promise.allSettled([...this.pending]);
  }
  options<T extends OperationOptions>(options: T): T {
    this.lifetime?.check();
    if (!this.signal) return options;
    const remaining = this.lifetime!.remaining();
    return {
      ...options,
      ...(remaining === undefined
        ? {}
        : { timeoutMs: Math.min(options.timeoutMs ?? Infinity, remaining) }),
      signal: options.signal ? AbortSignal.any([this.signal, options.signal]) : this.signal,
    };
  }
  call<T>(work: () => Promise<T>): Promise<T> {
    try {
      this.check();
      return this.track(work());
    } catch (error) {
      return Promise.reject(error);
    }
  }
}

class ExecutorHandle {
  constructor(readonly scope: Scope) {}
  get info() {
    return this.scope.connection.info;
  }
  get transactionStatus() {
    return this.scope.connection.transactionStatus;
  }
  query<T extends object = Row>(
    statement: string | Statement,
    options?: QueryOptions,
  ): Promise<QueryResult<T>>;
  query<T extends readonly unknown[] = readonly unknown[]>(
    statement: string | Statement,
    options: ArrayQueryOptions,
  ): Promise<QueryResult<T>>;
  query(
    statement: string | Statement,
    options: QueryOptions | ArrayQueryOptions = {},
  ): Promise<QueryResult<object>> {
    return this.scope.call(() => {
      validateOperation(options, ['rowMode']);
      const actual = this.scope.options(options);
      return actual.rowMode === 'array'
        ? this.scope.connection.query(statement, actual)
        : this.scope.connection.query(statement, actual);
    });
  }
  describe(
    statement: string | DescribeStatement,
    options: OperationOptions = {},
  ): Promise<Description> {
    return this.scope.call(() => {
      validateOperation(options);
      return this.scope.connection.describe(statement, this.scope.options(options));
    });
  }
}

/** Stop waiting for arbitrary user JavaScript on loss, expiry or a whole-scope deadline. */
export async function callback<T>(
  scope: Scope,
  work: () => Promise<T>,
  interrupt = true,
): Promise<T> {
  let stopLost = () => {},
    stopAbort = () => {};
  try {
    return await new Promise<T>((resolve, reject) => {
      const signal = scope.signal
        ? AbortSignal.any([scope.signal, scope.expiry.signal])
        : scope.expiry.signal;
      const abort = () => {
        const error = scope.signal?.aborted
          ? interrupt
            ? scope.interruption(abortError(scope.signal))
            : abortError(scope.signal)
          : signal.reason;
        scope.expire(error);
        reject(error);
        if (interrupt && scope.signal?.aborted) scope.connection.interrupt(error);
      };
      stopLost = scope.connection.onLost(() => {
        const error = scope.interruption(
          scope.signal?.aborted
            ? abortError(scope.signal)
            : new DriverError(
                'PGCLEAR_CONNECTION_LOST',
                'Session lost while executing a callback.',
              ),
        );
        scope.expire(error);
        reject(error);
      });
      signal.addEventListener('abort', abort, { once: true });
      stopAbort = () => signal.removeEventListener('abort', abort);
      if (signal.aborted) {
        abort();
        return;
      }
      void Promise.resolve()
        .then(() => {
          if (!scope.active) throw expired();
          scope.lifetime?.check();
          return work();
        })
        .then(resolve, reject);
    });
  } finally {
    stopLost();
    stopAbort();
  }
}

/** Accepted work drains within a fixed cleanup budget even when a callback never returns. */
export async function drain(scope: Scope, timeoutMs = 5000): Promise<void> {
  let stop = () => {};
  try {
    await Promise.race([
      scope.drain(),
      new Promise<never>((_, reject) => {
        stop = deadline(timeoutMs, () => {
          scope.connection.dispose();
          reject(new DriverError('PGCLEAR_TIMEOUT', 'Session cleanup deadline expired.'));
        });
      }),
    ]);
  } finally {
    stop();
  }
}

export function validateTransaction(work: unknown, options: TransactionOptions): void {
  validateOperation(options, ['isolation', 'readOnly', 'deferrable']);
  if (
    typeof work !== 'function' ||
    (options.isolation !== undefined &&
      !['read committed', 'repeatable read', 'serializable'].includes(options.isolation)) ||
    (options.readOnly !== undefined && typeof options.readOnly !== 'boolean') ||
    (options.deferrable !== undefined && typeof options.deferrable !== 'boolean') ||
    (options.deferrable && (options.isolation !== 'serializable' || options.readOnly !== true))
  )
    throw new DriverError('PGCLEAR_CONFIGURATION', 'Invalid transaction options.');
}

export class SessionHandle extends ExecutorHandle implements Session {
  script(text: string, options: OperationOptions = {}): Promise<readonly QueryResult[]> {
    return this.scope.call(() => {
      validateOperation(options);
      return this.scope.connection.script(text, this.scope.options(options));
    });
  }
  transaction<T>(
    work: (transaction: Transaction) => Promise<T>,
    options: TransactionOptions = {},
  ): Promise<T> {
    try {
      this.scope.check();
      validateTransaction(work, options);
      const life = new Lifetime(options, this.scope.lifetime);
      try {
        life.check();
      } catch (error) {
        life.stop();
        throw error;
      }
      const before = this.scope.drain(),
        child = new Scope(this.scope.connection, life);
      this.scope.child = child;
      return this.scope.track(transaction(this.scope, child, before, work, options, life));
    } catch (error) {
      return Promise.reject(error);
    }
  }
}
class TransactionHandle extends ExecutorHandle implements Transaction {
  savepoint<T>(work: (transaction: Transaction) => Promise<T>): Promise<T> {
    try {
      this.scope.check();
      if (typeof work !== 'function')
        throw new DriverError('PGCLEAR_CONFIGURATION', 'Expected a savepoint callback.');
      const before = this.scope.drain(),
        child = new Scope(this.scope.connection, this.scope.lifetime);
      this.scope.child = child;
      return this.scope.track(savepoint(this.scope, child, before, work));
    } catch (error) {
      return Promise.reject(error);
    }
  }
}

async function finishBody<T>(
  scope: Scope,
  work: (transaction: Transaction) => Promise<T>,
): Promise<T> {
  const value = await callback(scope, () => work(new TransactionHandle(scope)));
  if (scope.child) throw busy();
  scope.expire();
  await drain(scope);
  if (scope.poisoned || scope.connection.transactionStatus !== 'transaction') throw state();
  return value;
}
async function transaction<T>(
  parent: Scope,
  scope: Scope,
  before: Promise<unknown>,
  work: (transaction: Transaction) => Promise<T>,
  options: TransactionOptions,
  life: Lifetime,
): Promise<T> {
  const connection = scope.connection,
    errors: unknown[] = [];
  let began = false;
  try {
    await callback(
      scope,
      async () => {
        await before;
      },
      false,
    );
    if (!scope.active) throw expired();
    life.check();
    if (connection.transactionStatus !== 'idle')
      throw new DriverError(
        'PGCLEAR_SESSION_STATE',
        'A managed transaction requires an idle session.',
      );
    const begin =
      'BEGIN' +
      (options.isolation ? ' ISOLATION LEVEL ' + options.isolation.toUpperCase() : '') +
      (options.readOnly === undefined ? '' : options.readOnly ? ' READ ONLY' : ' READ WRITE') +
      (options.deferrable === undefined
        ? ''
        : options.deferrable
          ? ' DEFERRABLE'
          : ' NOT DEFERRABLE');
    await connection.query(begin, scope.options({ signal: life.signal }));
    began = true;
    const value = await finishBody(scope, work);
    life.check();
    const result = await connection.commit(scope.options({ signal: life.signal }));
    if (result.commandTag !== 'COMMIT') throw state();
    return value;
  } catch (error) {
    errors.push(error);
    scope.expire();
    const end = performance.now() + 5000,
      remaining = () => Math.max(0, Math.ceil(end - performance.now()));
    const stopCleanup = deadline(5000, () => connection.dispose());
    try {
      await drain(scope, remaining());
      if (began && connection.usable && connection.transactionStatus !== 'idle') {
        const result = await connection.query('ROLLBACK', { timeoutMs: remaining() });
        if (result.commandTag !== 'ROLLBACK' || !['idle'].includes(connection.transactionStatus))
          throw state();
      }
      if (!connection.usable) await connection.closed;
    } catch (cleanup) {
      errors.push(cleanup);
      connection.dispose();
      await connection.closed;
    } finally {
      stopCleanup();
    }
    throw combined(errors);
  } finally {
    scope.expire();
    life.stop();
    if (parent.child === scope) parent.child = undefined;
  }
}
let savepointId = 0;
async function savepoint<T>(
  parent: Scope,
  scope: Scope,
  before: Promise<unknown>,
  work: (transaction: Transaction) => Promise<T>,
): Promise<T> {
  const connection = scope.connection,
    name = 'pgclear_' + ++savepointId;
  const errors: unknown[] = [];
  let created = false;
  try {
    await callback(
      scope,
      async () => {
        await before;
      },
      false,
    );
    if (!scope.active) throw expired();
    if (parent.poisoned || connection.transactionStatus !== 'transaction') throw state();
    await connection.query('SAVEPOINT ' + name, scope.options({}));
    created = true;
    const value = await finishBody(scope, work);
    await connection.query('RELEASE SAVEPOINT ' + name, scope.options({}));
    return value;
  } catch (error) {
    errors.push(error);
    scope.expire();
    const end = performance.now() + 5000,
      remaining = () => Math.max(0, Math.ceil(end - performance.now()));
    const stopCleanup = deadline(5000, () => connection.dispose());
    try {
      await drain(scope, remaining());
      if (!created || !connection.usable) {
        parent.poisoned = true;
      } else {
        await connection.query('ROLLBACK TO SAVEPOINT ' + name, { timeoutMs: remaining() });
        await connection.query('RELEASE SAVEPOINT ' + name, { timeoutMs: remaining() });
        if (connection.transactionStatus !== 'transaction') throw state();
      }
    } catch (cleanup) {
      parent.poisoned = true;
      errors.push(cleanup);
    } finally {
      stopCleanup();
    }
    throw combined(errors);
  } finally {
    scope.expire();
    if (parent.child === scope) parent.child = undefined;
  }
}

export class ConnectionHandle extends SessionHandle implements Connection {
  constructor(connection: PhysicalConnection) {
    super(new Scope(connection));
  }
  close(options: CloseOptions = {}): Promise<void> {
    // Validate before permanently fencing an otherwise usable handle.
    try {
      validateOperation(options);
      if ('signal' in options)
        throw new DriverError('PGCLEAR_CONFIGURATION', 'Close accepts only timeoutMs.');
    } catch (error) {
      return Promise.reject(error);
    }
    this.scope.expire(new DriverError('PGCLEAR_CLOSED', 'The connection is closed.'));
    return this.scope.connection.close(options);
  }
}
