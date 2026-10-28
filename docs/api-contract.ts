/** Target API. Implemented signatures are imported from src; later features stay proposals. */

import type {
  ConnectionOptions,
  OperationOptions,
  SessionInfo,
  CloseOptions,
} from '../src/index.js';
export { connect, createPool, DriverError, DatabaseError } from '../src/index.js';
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
  InputValue,
  TextCodec,
  BinaryCodec,
  Codec,
  CodecRegistry,
  Parameter,
  PgArray,
  Statement,
  QueryTuple,
  SqlQuery,
  QueryInput,
  DescribeStatement,
  Description,
  Executor,
  PreparedStatement,
  PreparingExecutor,
  StreamingExecutor,
  CopyingExecutor,
  CopyStream,
  CopySource,
  StreamOptions,
  ArrayStreamOptions,
  StreamCompletion,
  RowStream,
  DatabaseNotice,
  ConnectionOptions,
  PoolOptions,
  Pool,
  Lease,
  Session,
  Transaction,
  TransactionOptions,
} from '../src/index.js';

export { param, json, sql, defaultCodecs, builtin } from '../src/index.js';

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
