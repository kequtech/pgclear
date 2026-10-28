/** Target API. Implemented signatures are imported from src; later features stay proposals. */
import type { Readable } from 'node:stream';

import type {
  Oid,
  WireFormat,
  Row,
  TransactionStatus,
  Outcome,
  Field,
  CommandResult,
  QueryResult,
  OperationOptions,
  QueryOptions,
  ArrayQueryOptions,
  CloseOptions,
  SessionInfo,
  PasswordContext,
  TlsOptions,
  InputValue as ScalarInputValue,
} from '../src/index.js';
export { connect, DriverError, DatabaseError } from '../src/index.js';
export type {
  Oid,
  WireFormat,
  Row,
  TransactionStatus,
  Outcome,
  Field,
  CommandResult,
  QueryResult,
  OperationOptions,
  QueryOptions,
  ArrayQueryOptions,
  CloseOptions,
  SessionInfo,
  PasswordContext,
  TlsOptions,
  DriverErrorCode,
} from '../src/index.js';

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

declare const parameterBrand: unique symbol;
export interface Parameter {
  readonly [parameterBrand]: true;
}
export type InputValue = ScalarInputValue | Parameter;
export declare function param<T>(
  value: NoInfer<T> | null,
  codec: Codec<T>,
  format?: WireFormat,
): Parameter;
/** JSON.stringify semantics; unlike param(null, codec), json(null) encodes a JSON null token. */
export declare function json(value: unknown, type?: 'json' | 'jsonb'): Parameter;
export declare const defaultCodecs: CodecRegistry;
export declare const builtin: {
  readonly bool: Codec<boolean>;
  readonly int2: Codec<number>;
  readonly int4: Codec<number>;
  readonly int8: Codec<bigint>;
  readonly float4: Codec<number>;
  readonly float8: Codec<number>;
  readonly numeric: Codec<string>;
  readonly text: Codec<string>;
  readonly uuid: Codec<string>;
  readonly bytea: Codec<Uint8Array>;
  readonly json: Codec<unknown>;
  readonly jsonb: Codec<unknown>;
  readonly jsonText: Codec<string>;
  readonly jsonbText: Codec<string>;
  readonly date: Codec<string>;
  readonly timestamp: Codec<string>;
  readonly timestamptz: Codec<string>;
  readonly int4Array: Codec<readonly (number | null)[]>;
  readonly int8Array: Codec<readonly (bigint | null)[]>;
  readonly numericArray: Codec<readonly (string | null)[]>;
  readonly textArray: Codec<readonly (string | null)[]>;
};

export interface Statement {
  readonly text: string;
  readonly values?: readonly InputValue[];
  readonly parameterTypes?: readonly Oid[];
}
export interface DescribeStatement {
  readonly text: string;
  readonly parameterTypes?: readonly Oid[];
}
export interface Description {
  readonly parameterTypes: readonly Oid[];
  readonly fields: readonly Field[];
}
export interface Executor {
  query<T extends object = Row>(
    statement: string | Statement,
    options?: QueryOptions,
  ): Promise<QueryResult<T>>;
  query<T extends readonly unknown[] = readonly unknown[]>(
    statement: string | Statement,
    options: ArrayQueryOptions,
  ): Promise<QueryResult<T>>;
  describe(statement: string | DescribeStatement, options?: OperationOptions): Promise<Description>;
}

export interface TransactionOptions extends OperationOptions {
  readonly isolation?: 'read committed' | 'repeatable read' | 'serializable';
  readonly readOnly?: boolean;
  readonly deferrable?: boolean;
}
export type StreamCompletion =
  { readonly status: 'complete'; readonly result: CommandResult } | { readonly status: 'closed' };
export interface RowStream<T> extends AsyncIterable<T> {
  readonly fields: Promise<readonly Field[]>;
  readonly completion: Promise<StreamCompletion>;
  close(): Promise<void>;
}
export interface CopyStream extends AsyncIterable<Uint8Array> {
  readonly completion: Promise<StreamCompletion>;
  close(): Promise<void>;
}
export interface StreamingExecutor extends Executor {
  stream<T extends object = Row>(
    statement: string | Statement,
    options?: QueryOptions & { readonly batchSize?: number },
  ): RowStream<T>;
  stream<T extends readonly unknown[] = readonly unknown[]>(
    statement: string | Statement,
    options: ArrayQueryOptions & { readonly batchSize?: number },
  ): RowStream<T>;
  copyFrom(
    text: string,
    source: AsyncIterable<Uint8Array> | Readable,
    options?: OperationOptions,
  ): Promise<CommandResult>;
  copyTo(text: string, options?: OperationOptions): CopyStream;
}
export interface PreparedStatement {
  readonly description: Description;
  query<T extends object = Row>(
    values?: readonly InputValue[],
    options?: QueryOptions,
  ): Promise<QueryResult<T>>;
  query<T extends readonly unknown[] = readonly unknown[]>(
    values: readonly InputValue[] | undefined,
    options: ArrayQueryOptions,
  ): Promise<QueryResult<T>>;
  close(): Promise<void>;
}
export interface Transaction extends StreamingExecutor {
  readonly info: SessionInfo;
  readonly transactionStatus: TransactionStatus;
  savepoint<T>(work: (transaction: Transaction) => Promise<T>): Promise<T>;
}
export interface Session extends StreamingExecutor {
  readonly info: SessionInfo;
  readonly transactionStatus: TransactionStatus;
  script(text: string, options?: OperationOptions): Promise<readonly QueryResult[]>;
  prepare(
    statement: string | DescribeStatement,
    options?: OperationOptions,
  ): Promise<PreparedStatement>;
  transaction<T>(
    work: (transaction: Transaction) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T>;
}
export interface PlannedConnection extends Session {
  close(options?: CloseOptions): Promise<void>;
}
export interface Lease extends Session {
  release(options?: { readonly discard?: boolean }): Promise<void>;
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
export interface PoolOptions extends ConnectionOptions {
  readonly maxConnections?: number;
  readonly maxWaiting?: number;
  readonly acquireTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly maxLifetimeMs?: number;
}
export declare function createPool(options: string | PoolOptions): Pool;

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
      readonly operation: 'query' | 'describe' | 'prepare' | 'script' | 'stream' | 'copy';
      readonly durationMs: number;
      readonly outcome: Outcome;
      readonly errorCode?: string;
    };

export interface Notification {
  readonly channel: string;
  readonly payload: string;
  readonly backendPid: number;
}
export type ListenerStatus =
  | { readonly state: 'connected'; readonly session: SessionInfo; readonly generation: number }
  | { readonly state: 'disconnected'; readonly error: Error; readonly generation: number }
  | { readonly state: 'reconnecting'; readonly attempt: number; readonly generation: number }
  | { readonly state: 'closed'; readonly generation: number };
export interface ListenerOptions extends OperationOptions {
  readonly channels: readonly string[];
  readonly onNotification: (notification: Notification) => void;
  readonly onStatus?: (status: ListenerStatus) => void;
  readonly reconnect?: boolean;
}
export interface Listener {
  readonly status: ListenerStatus;
  close(options?: CloseOptions): Promise<void>;
}
export declare function listen(
  connection: string | ConnectionOptions,
  options: ListenerOptions,
): Promise<Listener>;
