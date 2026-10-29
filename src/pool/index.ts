import {
  normalizeConfiguration,
  integer,
  record,
  validateOperation,
  validateClose,
  type Configuration,
} from '../config/index.js';
import { openConnection, type PhysicalConnection } from '../connection/index.js';
import { CLEANUP_TIMEOUT_MS, deadline, Lifetime } from '../connection/timing.js';
import { DriverError } from '../errors.js';
import {
  callback,
  drain,
  finishScope,
  Scope,
  SessionHandle,
  validateTransaction,
} from '../session/index.js';
import type {
  ArrayQueryOptions,
  CloseOptions,
  ConnectionOptions,
  DescribeStatement,
  Description,
  Lease,
  OperationOptions,
  Pool,
  PoolOptions,
  QueryOptions,
  QueryResult,
  Row,
  Session,
  InputValue,
  SqlQuery,
  Transaction,
  TransactionOptions,
} from '../types.js';

interface Settings {
  readonly connection: Configuration;
  readonly maxConnections: number;
  readonly maxWaiting: number;
  readonly acquireTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly maxLifetimeMs: number;
}
const poolKeys = [
  'maxConnections',
  'maxWaiting',
  'acquireTimeoutMs',
  'idleTimeoutMs',
  'maxLifetimeMs',
];
function settings(input: string | PoolOptions): Settings {
  const options = typeof input === 'string' ? { connectionString: input } : input;
  record(options, 'Pool options');
  for (const key of poolKeys)
    if (options[key as keyof PoolOptions] === null)
      throw new DriverError('PGCLEAR_CONFIGURATION', 'Pool options cannot be null.');
  return {
    connection: normalizeConfiguration(
      Object.fromEntries(
        Object.entries(options).filter(([key]) => !poolKeys.includes(key)),
      ) as ConnectionOptions,
    ),
    maxConnections: integer(options.maxConnections ?? 10, 'maxConnections', 1),
    maxWaiting: integer(options.maxWaiting ?? 1000, 'maxWaiting', 1),
    acquireTimeoutMs: integer(options.acquireTimeoutMs ?? 5000, 'acquireTimeoutMs', 0),
    idleTimeoutMs: integer(options.idleTimeoutMs ?? 30000, 'idleTimeoutMs', 0),
    maxLifetimeMs: integer(options.maxLifetimeMs ?? 0, 'maxLifetimeMs', 0),
  };
}
interface Waiter {
  readonly lifetime: Lifetime;
  readonly resolve: (lease: Lease) => void;
  readonly reject: (error: unknown) => void;
  active: boolean;
  stop: () => void;
  entry?: Entry;
}
interface Entry {
  readonly born: number;
  readonly controller: AbortController;
  state: 'connecting' | 'idle' | 'leased' | 'retiring';
  connection?: PhysicalConnection;
  handle?: LeaseHandle;
  waiter?: Waiter;
  attempt?: Promise<void>;
  retirement?: Promise<void>;
  stopIdle: () => void;
}
class LeaseHandle extends SessionHandle implements Lease {
  #release: Promise<void> | undefined;
  constructor(
    scope: Scope,
    private readonly finish: (discard: boolean) => Promise<void>,
  ) {
    super(scope);
  }
  release(options: { readonly discard?: boolean } = {}): Promise<void> {
    if (this.#release) return this.#release;
    try {
      record(options, 'Release options');
      if (
        Object.keys(options).some((key) => key !== 'discard') ||
        (options.discard !== undefined && typeof options.discard !== 'boolean')
      )
        throw new DriverError('PGCLEAR_CONFIGURATION', 'Invalid release options.');
      this.scope.expire();
      this.#release = this.finish(options.discard === true);
      return this.#release;
    } catch (error) {
      return Promise.reject(error);
    }
  }
}
class ConnectionPool implements Pool {
  readonly #settings: Settings;
  readonly #entries = new Set<Entry>();
  readonly #waiters: Waiter[] = [];
  #closing = false;
  #close: Promise<void> | undefined;
  constructor(input: string | PoolOptions) {
    this.#settings = settings(input);
  }
  get stats() {
    return Object.freeze({
      total: this.#entries.size,
      idle: [...this.#entries].filter((entry) => entry.state === 'idle').length,
      leased: [...this.#entries].filter((entry) => entry.state === 'leased').length,
      waiting: this.#waiters.length,
    });
  }
  acquire(options: OperationOptions = {}): Promise<Lease> {
    return this.#checkout(options);
  }
  #checkout(options: OperationOptions, parent?: Lifetime): Promise<Lease> {
    return new Promise((resolve, reject) => {
      let waiter: Waiter | undefined;
      try {
        validateOperation(options);
        if (this.#closing) throw new DriverError('PGCLEAR_CLOSED', 'The pool is closed.');
        if (this.#waiters.length >= this.#settings.maxWaiting)
          throw new DriverError('PGCLEAR_QUEUE_FULL', 'The pool acquisition queue is full.');
        const life = new Lifetime(
          options,
          parent,
          performance.now() + this.#settings.acquireTimeoutMs,
        );
        try {
          life.check();
        } catch (error) {
          life.stop();
          throw error;
        }
        waiter = { lifetime: life, resolve, reject, active: true, stop: () => {} };
        const accepted = waiter;
        accepted.stop = life.watch((error) => this.#reject(accepted, error));
        this.#waiters.push(accepted);
        this.#pump();
      } catch (error) {
        if (waiter) this.#reject(waiter, error);
        else reject(error);
      }
    });
  }
  #reject(waiter: Waiter, error: unknown, pump = true): void {
    if (!waiter.active) return;
    waiter.active = false;
    waiter.stop();
    const index = this.#waiters.indexOf(waiter);
    if (index !== -1) this.#waiters.splice(index, 1);
    waiter.entry?.controller.abort(error);
    waiter.reject(error);
    if (pump) this.#pump();
  }
  #publish(entry: Entry, waiter: Waiter): void {
    try {
      waiter.lifetime.check();
    } catch (error) {
      this.#reject(waiter, error, false);
      if (entry.state === 'connecting') void this.#retire(entry).catch(() => {});
      return;
    }

    if (this.#closing || !waiter.active || !entry.connection?.usable) {
      if (waiter.active)
        this.#reject(waiter, new DriverError('PGCLEAR_CLOSED', 'Pool closed before checkout.'));
      void this.#retire(entry).catch(() => {});
      return;
    }
    waiter.active = false;
    waiter.stop();
    delete waiter.entry;
    delete entry.waiter;
    entry.stopIdle();
    entry.state = 'leased';
    const scope = new Scope(entry.connection);
    const handle = new LeaseHandle(scope, (discard) => this.#release(entry, scope, discard));
    entry.handle = handle;
    waiter.resolve(handle);
  }
  #pump(): void {
    if (this.#closing) return;
    while (this.#waiters.length) {
      let entry = [...this.#entries].find((candidate) => candidate.state === 'idle');
      if (entry && (!entry.connection!.usable || this.#expired(entry))) {
        void this.#retire(entry).catch(() => {});
        continue;
      }
      if (entry) {
        this.#publish(entry, this.#waiters.shift()!);
        continue;
      }
      if (this.#entries.size >= this.#settings.maxConnections) return;
      const waiter = this.#waiters.shift()!;
      entry = {
        born: performance.now(),
        controller: new AbortController(),
        state: 'connecting',
        stopIdle: () => {},
      };
      this.#entries.add(entry);
      waiter.entry = entry;
      entry.waiter = waiter;
      const opening = entry;
      opening.attempt = (async () => {
        try {
          const connection = await openConnection(this.#settings.connection, {
            signal: opening.controller.signal,
          });
          opening.connection = connection;
          void connection.closed.then(() => {
            opening.handle?.scope.expire();
            if (opening.state !== 'retiring') {
              this.#entries.delete(opening);
              this.#pump();
            }
          });
          this.#publish(opening, waiter);
        } catch (error) {
          this.#reject(waiter, error);
          this.#entries.delete(opening);
          this.#pump();
        } finally {
          delete opening.waiter;
        }
      })();
    }
  }
  #expired(entry: Entry): boolean {
    return (
      this.#settings.maxLifetimeMs > 0 &&
      performance.now() - entry.born >= this.#settings.maxLifetimeMs
    );
  }
  async #release(entry: Entry, scope: Scope, discard: boolean): Promise<void> {
    const end = Math.min(performance.now() + CLEANUP_TIMEOUT_MS, scope.cleanupDeadline ?? Infinity),
      remaining = () => Math.max(0, Math.ceil(end - performance.now()));
    try {
      await drain(scope, remaining());
      if (
        discard ||
        scope.abandonedStream ||
        this.#closing ||
        !entry.connection!.usable ||
        entry.connection!.transactionStatus !== 'idle' ||
        this.#expired(entry)
      ) {
        await this.#retire(entry, remaining());
        return;
      }
      delete entry.handle;
      entry.state = 'idle';
      if (this.#settings.idleTimeoutMs > 0) {
        entry.stopIdle = deadline(
          this.#settings.idleTimeoutMs,
          () => {
            void this.#retire(entry).catch(() => {});
          },
          true,
        );
      }
      this.#pump();
    } catch (error) {
      try {
        await this.#retire(entry, remaining());
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'Lease release and disposal failed.');
      }
      throw error;
    }
  }
  #retire(entry: Entry, timeoutMs = CLEANUP_TIMEOUT_MS): Promise<void> {
    if (entry.retirement) return entry.retirement;
    const end = performance.now() + timeoutMs;
    entry.state = 'retiring';
    entry.stopIdle();
    entry.handle?.scope.expire();
    entry.controller.abort();
    entry.retirement = (async () => {
      try {
        await entry.attempt;
        if (entry.connection) {
          try {
            await entry.connection.close({
              timeoutMs: Math.max(0, Math.ceil(end - performance.now())),
            });
          } finally {
            entry.connection.dispose();
            await entry.connection.closed;
          }
        }
      } finally {
        this.#entries.delete(entry);
        this.#pump();
      }
    })();
    return entry.retirement;
  }

  query<T extends object = Row>(
    statement: SqlQuery<T>,
    options?: QueryOptions,
  ): Promise<QueryResult<T>>;
  query<T extends readonly unknown[] = readonly unknown[]>(
    statement: SqlQuery<T>,
    options: ArrayQueryOptions,
  ): Promise<QueryResult<T>>;
  query(
    statement: SqlQuery<object>,
    options: ArrayQueryOptions,
  ): Promise<QueryResult<readonly unknown[]>>;
  query(
    statement: SqlQuery<object>,
    options: QueryOptions | ArrayQueryOptions = {},
  ): Promise<QueryResult<object>> {
    return this.#query(options, (lease, actual) =>
      actual.rowMode === 'array' ? lease.query(statement, actual) : lease.query(statement, actual),
    );
  }
  queryClassic<T extends object = Row>(
    text: string,
    values?: readonly InputValue[],
    options?: QueryOptions,
  ): Promise<QueryResult<T>>;
  queryClassic<T extends readonly unknown[] = readonly unknown[]>(
    text: string,
    values: readonly InputValue[] | undefined,
    options: ArrayQueryOptions,
  ): Promise<QueryResult<T>>;
  queryClassic(
    text: string,
    values: readonly InputValue[] = [],
    options: QueryOptions | ArrayQueryOptions = {},
  ): Promise<QueryResult<object>> {
    return this.#query(options, (lease, actual) =>
      actual.rowMode === 'array'
        ? lease.queryClassic(text, values, actual)
        : lease.queryClassic(text, values, actual),
    );
  }

  #query(
    options: QueryOptions | ArrayQueryOptions,
    work: (
      lease: Session,
      actual: QueryOptions | ArrayQueryOptions,
    ) => Promise<QueryResult<object>>,
  ): Promise<QueryResult<object>> {
    return this.#withLease(options, ['rowMode'], async (lease) => {
      const actual = options.rowMode === 'array' ? { rowMode: 'array' as const } : {};
      const result = await work(lease, actual);
      if (lease.transactionStatus !== 'idle')
        throw new DriverError(
          'PGCLEAR_SESSION_STATE',
          'One-off pool operations must leave the session idle.',
          'confirmed',
        );
      return result;
    });
  }

  describe(
    statement: string | DescribeStatement,
    options: OperationOptions = {},
  ): Promise<Description> {
    return this.#withLease(options, [], (session) => session.describe(statement));
  }
  async #withLease<T>(
    options: OperationOptions,
    extra: readonly string[],
    work: (session: SessionHandle) => Promise<T>,
    discardOnFailure = false,
  ): Promise<T> {
    validateOperation(options, extra);
    const life = new Lifetime(options);
    let lease: LeaseHandle | undefined,
      failed = false,
      error: unknown;
    try {
      life.check();
      lease = (await this.#checkout({}, life)) as LeaseHandle;
      life.check();
      const scope = new Scope(lease.scope.connection, life);
      lease.scope.child = scope;
      try {
        return await lease.scope.track(finishScope(scope, () => work(new SessionHandle(scope))));
      } finally {
        lease.scope.cleanupDeadline = scope.cleanupDeadline;
        lease.scope.child = undefined;
      }
    } catch (cause) {
      failed = true;
      error = cause;
      throw cause;
    } finally {
      life.stop();
      if (lease) {
        try {
          await lease.release({ discard: discardOnFailure && failed });
        } catch (cleanup) {
          if (failed)
            throw new AggregateError([error, cleanup], 'Operation and lease cleanup failed.');
          throw cleanup;
        }
      }
    }
  }
  async withSession<T>(
    work: (session: Session) => Promise<T>,
    options: OperationOptions = {},
  ): Promise<T> {
    validateOperation(options);
    if (typeof work !== 'function')
      throw new DriverError('PGCLEAR_CONFIGURATION', 'Expected a session callback.');
    return this.#withLease(
      options,
      [],
      (session) => callback(session.scope, () => work(session)),
      true,
    );
  }
  transaction<T>(
    work: (transaction: Transaction) => Promise<T>,
    options: TransactionOptions = {},
  ): Promise<T> {
    // Validate transaction policy before taking a lease or opening a socket.
    try {
      validateTransaction(work, options);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#withLease(options, ['isolation', 'readOnly', 'deferrable'], (session) =>
      session.transaction(work, {
        ...(options.isolation === undefined ? {} : { isolation: options.isolation }),
        ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
        ...(options.deferrable === undefined ? {} : { deferrable: options.deferrable }),
      }),
    );
  }
  close(options: CloseOptions = {}): Promise<void> {
    if (this.#close) return this.#close;
    try {
      validateClose(options);
      const timeout = options.timeoutMs ?? CLEANUP_TIMEOUT_MS;
      this.#closing = true;
      for (const waiter of [...this.#waiters])
        this.#reject(waiter, new DriverError('PGCLEAR_CLOSED', 'Pool closed before acquisition.'));
      const entries = [...this.#entries];
      for (const entry of entries) {
        if (entry.waiter?.active)
          this.#reject(
            entry.waiter,
            new DriverError('PGCLEAR_CLOSED', 'Pool closed during startup.'),
          );
        entry.handle?.scope.expire();
        entry.controller.abort(new DriverError('PGCLEAR_CLOSED', 'Pool closed during startup.'));
      }
      this.#close = (async () => {
        const results = await Promise.allSettled(
          entries.map((entry) => this.#retire(entry, timeout)),
        );
        const errors = results
          .filter((result) => result.status === 'rejected')
          .map((result) => result.reason);
        if (errors.length)
          throw new AggregateError(errors, 'Pool shutdown failed after all disposal attempts.');
      })();
      return this.#close;
    } catch (error) {
      return Promise.reject(error);
    }
  }
}
export function createPool(options: string | PoolOptions): Pool {
  return new ConnectionPool(options);
}
