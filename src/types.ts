/** Implemented runtime API. Later milestones remain proposals in docs/. */
export type Oid = number;
export type WireFormat = 'text' | 'binary';
export type Row = Readonly<Record<string, unknown>>;
export type TransactionStatus = 'idle' | 'transaction' | 'failed';
export type Outcome = 'not-sent' | 'confirmed' | 'unknown';
/** Rectangular PostgreSQL arrays. SQL NULL is represented by null at the element level. */
export type PgArray<T> = readonly (T | null | PgArray<T>)[];
declare const parameterBrand: unique symbol;
export interface Parameter {
  readonly [parameterBrand]: true;
}
export type InputValue = null | string | number | bigint | boolean | Uint8Array | Parameter;
export interface TextCodec<T> {
  readonly encode: (value: T) => string;
  readonly decode: (value: string) => T;
}
export interface BinaryCodec<T> {
  readonly encode: (value: T) => Uint8Array;
  readonly decode: (value: Uint8Array) => T;
}
export interface Codec<T> {
  readonly oid: Oid;
  readonly text?: TextCodec<T>;
  readonly binary?: BinaryCodec<T>;
}
export interface CodecRegistry {
  with<T>(codec: Codec<T>): CodecRegistry;
}

export interface Field {
  readonly name: string;
  readonly dataTypeOid: Oid;
  readonly tableOid: Oid;
  readonly columnAttribute: number;
  readonly dataTypeSize: number;
  readonly typeModifier: number;
  readonly format: WireFormat;
}
export interface CommandResult {
  readonly command: string;
  readonly commandTag: string;
  readonly rowCount: bigint | null;
}
export interface QueryResult<T = Row> extends CommandResult {
  readonly rows: readonly T[];
  readonly fields: readonly Field[];
}
export interface Statement {
  readonly text: string;
  readonly values?: readonly InputValue[];
  readonly parameterTypes?: readonly Oid[];
}
/** Classic parameterized query form. Values are always binds, never SQL fragments. */
export type QueryTuple = readonly [text: string, values: readonly InputValue[]];
declare const sqlRow: unique symbol;
/** A query tuple with a caller-asserted row type; the marker has no runtime value. */
export type SqlQuery<T extends object = Row> = QueryTuple & { readonly [sqlRow]?: T };
export type QueryInput<T extends object = Row> = string | Statement | SqlQuery<T>;
export interface DescribeStatement {
  readonly text: string;
  readonly parameterTypes?: readonly Oid[];
}
export interface Description {
  readonly parameterTypes: readonly Oid[];
  readonly fields: readonly Field[];
}
export interface OperationOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}
export interface QueryOptions extends OperationOptions {
  readonly rowMode?: 'object';
}
export interface ArrayQueryOptions extends OperationOptions {
  readonly rowMode: 'array';
}
export interface CloseOptions {
  readonly timeoutMs?: number;
}
export interface SessionInfo {
  readonly id: number;
  readonly backendPid: number;
  readonly serverVersion: string;
}
export interface Executor {
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
  describe(statement: string | DescribeStatement, options?: OperationOptions): Promise<Description>;
}
export interface TransactionOptions extends OperationOptions {
  readonly isolation?: 'read committed' | 'repeatable read' | 'serializable';
  readonly readOnly?: boolean;
  readonly deferrable?: boolean;
}
export interface Transaction extends Executor {
  readonly info: SessionInfo;
  readonly transactionStatus: TransactionStatus;
  savepoint<T>(work: (transaction: Transaction) => Promise<T>): Promise<T>;
}
export interface Session extends Executor {
  readonly info: SessionInfo;
  /** Last observed ReadyForQuery status; this is not a liveness probe. */
  readonly transactionStatus: TransactionStatus;
  script(text: string, options?: OperationOptions): Promise<readonly QueryResult[]>;
  transaction<T>(
    work: (transaction: Transaction) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T>;
}
export interface Connection extends Session {
  close(options?: CloseOptions): Promise<void>;
}
export interface Lease extends Session {
  release(options?: { readonly discard?: boolean }): Promise<void>;
}
export interface PoolOptions extends ConnectionOptions {
  readonly maxConnections?: number;
  readonly maxWaiting?: number;
  readonly acquireTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly maxLifetimeMs?: number;
}
export interface Pool extends Executor {
  acquire(options?: OperationOptions): Promise<Lease>;
  withSession<T>(work: (session: Session) => Promise<T>, options?: OperationOptions): Promise<T>;
  transaction<T>(
    work: (transaction: Transaction) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T>;
  readonly stats: {
    readonly total: number;
    readonly idle: number;
    readonly leased: number;
    readonly waiting: number;
  };
  close(options?: CloseOptions): Promise<void>;
}
export interface PasswordContext {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly database: string;
}
export interface TlsOptions {
  readonly ca?: string | readonly string[];
  readonly cert?: string;
  readonly key?: string;
  readonly serverName?: string;
  readonly channelBinding?: 'prefer' | 'require' | 'disable';
}
export interface ConnectionOptions {
  readonly connectionString?: string;
  readonly host?: string;
  readonly port?: number;
  readonly user?: string;
  readonly database?: string;
  readonly password?: string | ((context: PasswordContext) => string | Promise<string>);
  readonly tls?: false | TlsOptions;
  readonly applicationName?: string;
  readonly startupParameters?: Readonly<Record<string, string>>;
  readonly codecs?: CodecRegistry;
  readonly connectTimeoutMs?: number;
  readonly maxQueuedOperations?: number;
  readonly maxMessageBytes?: number;
  readonly maxResultBytes?: number;
  readonly onEvent?: (event: DriverEvent) => void;
}
export interface DatabaseNotice {
  readonly severity: string;
  readonly code: string;
  readonly message: string;
  readonly detail?: string;
  readonly hint?: string;
}
export type DriverEvent =
  | { readonly type: 'connect'; readonly session: SessionInfo }
  | { readonly type: 'disconnect'; readonly session: SessionInfo; readonly expected: boolean }
  | { readonly type: 'notice'; readonly session: SessionInfo; readonly notice: DatabaseNotice }
  | {
      readonly type: 'operation';
      readonly sessionId: number;
      readonly operation: 'query' | 'describe' | 'script';
      readonly durationMs: number;
      readonly outcome: Outcome;
      readonly errorCode?: string;
    };
