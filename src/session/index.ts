import type { PhysicalConnection } from '../connection/index.js';
import {
  CLEANUP_TIMEOUT_MS,
  abortError,
  deadline,
  Lifetime,
  type ExecutionOptions,
} from '../connection/timing.js';
import { validateOperation, validateClose } from '../config/index.js';
import { DriverError } from '../errors.js';
import { OutputStream, PortalStream } from '../connection/stream.js';
import { PreparedHandle } from './prepared.js';
import type {
  ArrayQueryOptions,
  CloseOptions,
  Connection,
  DescribeStatement,
  Description,
  OperationOptions,
  PreparedStatement,
  QueryOptions,
  QueryResult,
  Row,
  Session,
  InputValue,
  QueryInput,
  Transaction,
  TransactionOptions,
  RowStream,
  StreamOptions,
  ArrayStreamOptions,
  CommandResult,
  CopySource,
  CopyStream,
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
  #reservation:
    { output?: Pick<OutputStream<unknown>, 'closing' | 'settled' | 'close'> } | undefined;
  abandonedStream = false;
  cleanupDeadline: number | undefined;
  #expiry: AbortController | undefined;
  #expiryReason: unknown;
  readonly pending = new Set<Promise<unknown>>();
  readonly statements = new Set<PreparedHandle>();
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
  // Ordinary query cleanup needs only the active fence. Callbacks also observe expiry.
  get expiry(): AbortSignal {
    if (!this.#expiry) {
      this.#expiry = new AbortController();
      if (!this.active) this.#expiry.abort(this.#expiryReason ?? expired());
    }
    return this.#expiry.signal;
  }
  check(): void {
    if (!this.active)
      throw this.#expiryReason instanceof DriverError &&
        this.#expiryReason.code === 'PGCLEAR_CLOSED'
        ? this.#expiryReason
        : expired();
    if (!this.connection.usable)
      throw new DriverError('PGCLEAR_CLOSED', 'The physical session is closed.');
    if (this.child) throw busy();
    if (this.#reservation) throw new DriverError('PGCLEAR_BUSY', 'A stream owns this session.');
    this.lifetime?.check();
  }
  expire(reason?: unknown): void {
    if (!this.active) return;
    this.active = false;
    this.#expiryReason = reason;
    this.cleanupDeadline ??= performance.now() + CLEANUP_TIMEOUT_MS;
    const stream = this.#reservation?.output;
    if (stream && !stream.settled) {
      this.abandonedStream ||= !stream.closing;
      void stream.close(this.cleanupDeadline).catch(() => {});
    }
    this.child?.expire(reason);
    this.#expiry?.abort(reason ?? expired());
  }
  track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    void promise.then(
      () => this.pending.delete(promise),
      () => this.pending.delete(promise),
    );
    return promise;
  }
  claim<T>(
    work: () => Promise<T>,
    stream?: Pick<OutputStream<unknown>, 'closing' | 'settled' | 'close'>,
  ): Promise<T> {
    this.check();
    const reservation = stream ? { output: stream } : {};
    this.#reservation = reservation;
    const clear = () => {
      if (this.#reservation === reservation) this.#reservation = undefined;
    };
    try {
      const promise = this.track(work());
      void promise.then(clear, clear);
      return promise;
    } catch (error) {
      clear();
      throw error;
    }
  }
  drain(): Promise<unknown> {
    return Promise.allSettled([...this.pending]);
  }
  options<T extends OperationOptions>(options: T, extra: readonly string[] = []): ExecutionOptions {
    validateOperation(options, extra);
    this.lifetime?.check();
    return { ...options, lifetime: new Lifetime(options, this.lifetime) };
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
    statement: QueryInput<T>,
    options?: QueryOptions,
  ): Promise<QueryResult<T>>;
  query<T extends readonly unknown[] = readonly unknown[]>(
    statement: QueryInput<T>,
    options: ArrayQueryOptions,
  ): Promise<QueryResult<T>>;
  query(
    statement: QueryInput<object>,
    options: ArrayQueryOptions,
  ): Promise<QueryResult<readonly unknown[]>>;
  query(
    statement: QueryInput<object>,
    options: QueryOptions | ArrayQueryOptions = {},
  ): Promise<QueryResult<object>> {
    return this.scope.call(() => {
      return this.scope.connection.query(statement, this.scope.options(options, ['rowMode']));
    });
  }
  queryClassic<T extends object = Row>(
    text: string,
    values: readonly InputValue[],
    options?: QueryOptions,
  ): Promise<QueryResult<T>>;
  queryClassic<T extends readonly unknown[] = readonly unknown[]>(
    text: string,
    values: readonly InputValue[],
    options: ArrayQueryOptions,
  ): Promise<QueryResult<T>>;
  queryClassic(
    text: string,
    values: readonly InputValue[],
    options: QueryOptions | ArrayQueryOptions = {},
  ): Promise<QueryResult<object>> {
    return options?.rowMode === 'array'
      ? this.query([text, values], options)
      : this.query([text, values], options);
  }

  stream<T extends object = Row>(statement: QueryInput<T>, options?: StreamOptions): RowStream<T>;
  stream<T extends readonly unknown[] = readonly unknown[]>(
    statement: QueryInput<T>,
    options: ArrayStreamOptions,
  ): RowStream<T>;
  stream(statement: QueryInput<object>, options: ArrayStreamOptions): RowStream<readonly unknown[]>;
  stream(
    statement: QueryInput<object>,
    options: StreamOptions | ArrayStreamOptions = {},
  ): RowStream<object> {
    const stream = new PortalStream();
    try {
      this.scope.claim(() => {
        this.scope.connection.stream(
          statement,
          this.scope.options(options, ['rowMode', 'batchSize']),
          stream,
        );
        return stream.completion;
      }, stream);
    } catch (error) {
      stream.fail(error);
    }
    return stream;
  }

  copyFrom(
    text: string,
    source: CopySource,
    options: OperationOptions = {},
  ): Promise<CommandResult> {
    try {
      return this.scope.claim(() =>
        this.scope.connection.copyFrom(text, source, this.scope.options(options)),
      );
    } catch (error) {
      return Promise.reject(error);
    }
  }
  copyTo(text: string, options: OperationOptions = {}): CopyStream {
    const output = new OutputStream<Uint8Array>();
    try {
      this.scope.claim(() => {
        this.scope.connection.copyTo(text, this.scope.options(options), output);
        return output.completion;
      }, output);
    } catch (error) {
      output.fail(error);
    }
    return output;
  }

  prepare(
    statement: string | DescribeStatement,
    options: OperationOptions = {},
  ): Promise<PreparedStatement> {
    return this.scope.call(() => {
      const actual = this.scope.options(options);
      return new PreparedHandle(this.scope).create(statement, actual);
    });
  }

  describe(
    statement: string | DescribeStatement,
    options: OperationOptions = {},
  ): Promise<Description> {
    return this.scope.call(() => {
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
      const signal = scope.signal ? AbortSignal.any([scope.signal, scope.expiry]) : scope.expiry;
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
export async function drain(scope: Scope, timeoutMs = CLEANUP_TIMEOUT_MS): Promise<void> {
  const end = Math.min(scope.cleanupDeadline ?? Infinity, performance.now() + timeoutMs);
  scope.cleanupDeadline = end;
  if (scope.pending.size === 0 && scope.statements.size === 0) return;
  let stop = () => {};
  try {
    await Promise.race([
      (async () => {
        await scope.drain();
        for (const statement of scope.statements) await statement.dispose(end);
      })(),
      new Promise<never>((_, reject) => {
        stop = deadline(Math.max(0, end - performance.now()), () => {
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
      return withChild(this.scope, life, (child, before) =>
        transaction(child, before, work, options, life),
      );
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
      return withChild(this.scope, this.scope.lifetime, (child, before) =>
        savepoint(this.scope, child, before, work),
      );
    } catch (error) {
      return Promise.reject(error);
    }
  }
}

/** Reserve synchronously; detach only after the complete child operation settles. */
function withChild<T>(
  parent: Scope,
  life: Lifetime | undefined,
  work: (scope: Scope, before: Promise<unknown>) => Promise<T>,
): Promise<T> {
  const before = parent.drain(),
    child = new Scope(parent.connection, life);
  parent.child = child;
  return parent.track(
    (async () => {
      try {
        return await work(child, before);
      } finally {
        child.expire();
        if (parent.child === child) parent.child = undefined;
      }
    })(),
  );
}
async function enterScope(scope: Scope, before: Promise<unknown>): Promise<void> {
  // Waiting for earlier work must not cancel that work if this child expires.
  await callback(
    scope,
    async () => {
      await before;
    },
    false,
  );
  if (!scope.active) throw expired();
  scope.lifetime?.check();
}
async function recoverScope(
  scope: Scope,
  work: (cleanup: Lifetime) => Promise<void>,
): Promise<void> {
  scope.expire();
  const cleanup = new Lifetime({}, undefined, scope.cleanupDeadline!);
  // Force disposal before notifying child wire operations of cleanup expiry.
  const stop = cleanup.watch(() => scope.connection.dispose());
  try {
    await drain(scope);
    await work(cleanup);
  } finally {
    stop();
  }
}

/** Expire a capability, drain accepted work, and preserve work plus cleanup failures. */
export async function finishScope<T>(scope: Scope, work: () => Promise<T>): Promise<T> {
  const errors: unknown[] = [];
  let value: T | undefined;
  try {
    value = await work();
  } catch (error) {
    errors.push(error);
  }
  scope.expire();
  try {
    await drain(scope);
    if (scope.abandonedStream && errors.length === 0)
      errors.push(new DriverError('PGCLEAR_BUSY', 'A callback left an unfinished stream.'));
  } catch (error) {
    errors.push(error);
  }
  if (errors.length) throw combined(errors);
  return value as T;
}
async function finishBody<T>(
  scope: Scope,
  work: (transaction: Transaction) => Promise<T>,
): Promise<T> {
  const value = await finishScope(scope, async () => {
    const value = await callback(scope, () => work(new TransactionHandle(scope)));
    if (scope.child) throw busy();
    return value;
  });
  if (scope.poisoned || scope.connection.transactionStatus !== 'transaction') throw state();
  return value;
}
async function transaction<T>(
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
    await enterScope(scope, before);
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
    await connection.query(begin, scope.options({}));
    began = true;
    const value = await finishBody(scope, work);
    life.check();
    const result = await connection.commit(scope.options({}));
    if (result.commandTag !== 'COMMIT') throw state();
    return value;
  } catch (error) {
    errors.push(error);
    try {
      await recoverScope(scope, async (cleanup) => {
        if (began && connection.usable && connection.transactionStatus !== 'idle') {
          const result = await connection.query('ROLLBACK', {
            lifetime: new Lifetime({}, cleanup),
          });
          if (result.commandTag !== 'ROLLBACK' || !['idle'].includes(connection.transactionStatus))
            throw state();
        }
        if (!connection.usable) await connection.closed;
      });
    } catch (cleanup) {
      errors.push(cleanup);
      connection.dispose();
      await connection.closed;
    }
    throw combined(errors);
  } finally {
    life.stop();
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
    await enterScope(scope, before);
    if (parent.poisoned || connection.transactionStatus !== 'transaction') throw state();
    await connection.query('SAVEPOINT ' + name, scope.options({}));
    created = true;
    const value = await finishBody(scope, work);
    await connection.query('RELEASE SAVEPOINT ' + name, scope.options({}));
    return value;
  } catch (error) {
    errors.push(error);
    try {
      await recoverScope(scope, async (cleanup) => {
        if (!created || !connection.usable) {
          parent.poisoned = true;
        } else {
          await connection.query('ROLLBACK TO SAVEPOINT ' + name, {
            lifetime: new Lifetime({}, cleanup),
          });
          await connection.query('RELEASE SAVEPOINT ' + name, {
            lifetime: new Lifetime({}, cleanup),
          });
          if (connection.transactionStatus !== 'transaction') throw state();
        }
      });
    } catch (cleanup) {
      parent.poisoned = true;
      errors.push(cleanup);
    }
    throw combined(errors);
  }
}

export class ConnectionHandle extends SessionHandle implements Connection {
  constructor(connection: PhysicalConnection) {
    super(new Scope(connection));
  }
  close(options: CloseOptions = {}): Promise<void> {
    // Validate before permanently fencing an otherwise usable handle.
    try {
      validateClose(options);
    } catch (error) {
      return Promise.reject(error);
    }
    this.scope.expire(new DriverError('PGCLEAR_CLOSED', 'The connection is closed.'));
    return this.scope.connection.close(options);
  }
}
