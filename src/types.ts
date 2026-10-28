/** Runtime API implemented by the connection milestone. Later APIs remain in docs/. */
export type Oid = number;
export type WireFormat = 'text' | 'binary';
export type Row = Readonly<Record<string, unknown>>;
export type TransactionStatus = 'idle' | 'transaction' | 'failed';
export type Outcome = 'not-sent' | 'confirmed' | 'unknown';
export type InputValue = null | string | number | bigint | boolean | Uint8Array;

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
export interface Connection {
  readonly info: SessionInfo;
  /** Last observed ReadyForQuery status; this is not a liveness probe. */
  readonly transactionStatus: TransactionStatus;
  query<T extends object = Row>(
    statement: string | Statement,
    options?: QueryOptions,
  ): Promise<QueryResult<T>>;
  query<T extends readonly unknown[] = readonly unknown[]>(
    statement: string | Statement,
    options: ArrayQueryOptions,
  ): Promise<QueryResult<T>>;
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
      readonly operation: 'query';
      readonly durationMs: number;
      readonly outcome: Outcome;
      readonly errorCode?: string;
    };
