import { CLEANUP_TIMEOUT_MS, Lifetime, type ExecutionOptions } from '../connection/timing.js';
import { DriverError } from '../errors.js';
import type {
  ArrayQueryOptions,
  DescribeStatement,
  Description,
  InputValue,
  PreparedStatement,
  QueryOptions,
  QueryResult,
  Row,
} from '../types.js';
import type { Scope } from './index.js';

/** Submitted names remain owned until creation fails cleanly or Close is acknowledged. */
export class PreparedHandle implements PreparedStatement {
  #description: Description | undefined;
  #close: Promise<void> | undefined;
  readonly #name: string;
  constructor(readonly scope: Scope) {
    this.#name = scope.connection.allocateStatementName();
    scope.statements.add(this);
  }
  get description(): Description {
    return this.#description!;
  }
  async create(
    statement: string | DescribeStatement,
    options: ExecutionOptions,
  ): Promise<PreparedStatement> {
    try {
      this.#description = await this.scope.connection.prepare(this.#name, statement, options);
      return this;
    } catch (error) {
      // A rejected Parse/Describe may still have created the named statement. Local failures
      // have sent nothing; connection loss destroys all names along with the physical session.
      if (error instanceof DriverError && error.outcome === 'not-sent') {
        this.scope.statements.delete(this);
      } else {
        try {
          await this.dispose();
        } catch (cleanup) {
          throw new AggregateError([error, cleanup], 'Preparation and statement cleanup failed.');
        }
      }
      throw error;
    }
  }
  query<T extends object = Row>(
    values?: readonly InputValue[],
    options?: QueryOptions,
  ): Promise<QueryResult<T>>;
  query<T extends readonly unknown[] = readonly unknown[]>(
    values: readonly InputValue[] | undefined,
    options: ArrayQueryOptions,
  ): Promise<QueryResult<T>>;
  query(
    values: readonly InputValue[] = [],
    options: QueryOptions | ArrayQueryOptions = {},
  ): Promise<QueryResult<object>> {
    return this.scope.call(() => {
      if (this.#close || !this.#description)
        throw new DriverError('PGCLEAR_EXPIRED', 'This prepared statement is closed.');
      return this.scope.connection.preparedQuery(
        this.#name,
        values,
        this.#description,
        this.scope.options(options, ['rowMode']),
      );
    });
  }
  close(): Promise<void> {
    if (this.#close) return this.#close;
    // Expiry cleanup owns server disposal. A lost transport has already disposed every name.
    if (!this.scope.active || !this.scope.connection.usable) return Promise.resolve();
    return this.scope.call(() => this.dispose());
  }
  dispose(end = performance.now() + CLEANUP_TIMEOUT_MS): Promise<void> {
    if (this.#close) return this.#close;
    // Fence reentrant calls before enqueuing Close after all accepted executions.
    const completion = Promise.withResolvers<void>();
    this.#close = completion.promise;
    const work = this.scope.connection.usable
      ? this.scope.connection.closeStatement(this.#name, {
          lifetime: new Lifetime({}, undefined, end),
        })
      : Promise.resolve();
    void work.then(
      () => {
        this.scope.statements.delete(this);
        completion.resolve();
      },
      (error: unknown) => {
        // An unacknowledged Close cannot permit this session to be reused.
        this.scope.connection.dispose();
        completion.reject(error);
      },
    );
    return this.#close;
  }
}
