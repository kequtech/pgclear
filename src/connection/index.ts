import { Authenticator } from '../auth/index.js';
import {
  normalizeConfiguration,
  validateOperation,
  integer,
  type Configuration,
} from '../config/index.js';
import { DatabaseError, DriverError, protocolError } from '../errors.js';
import { FrameDecoder, startup, terminate } from '../protocol/framing.js';
import { decodeMessage, type Message } from '../protocol/messages.js';
import type {
  ArrayQueryOptions,
  CloseOptions,
  CommandResult,
  Description,
  DescribeStatement,
  ConnectionOptions,
  DriverEvent,
  Field,
  OperationOptions,
  Outcome,
  QueryOptions,
  QueryResult,
  Row,
  SessionInfo,
  Statement,
  TransactionStatus,
} from '../types.js';
import { ConnectionHandle } from '../session/index.js';
import { cancel } from '../transport/cancel.js';
import { Transport } from '../transport/index.js';
import { commandResult, encodeDescribe, encodeQuery, encodeScript } from './query.js';
import { deadline, watchOperation } from './timing.js';

interface Operation {
  readonly kind: 'query' | 'describe' | 'script';
  readonly commit: boolean;
  wire: Buffer | undefined;
  readonly arrayMode: boolean;
  readonly complete: (operation: Operation) => void;
  readonly reject: (error: unknown) => void;
  readonly started: number;
  stop: () => void;
  phase:
    | 'encoding'
    | 'queued'
    | 'parse'
    | 'bind'
    | 'parameters'
    | 'description'
    | 'rows'
    | 'script'
    | 'ready'
    | 'settled';
  fields: readonly Field[];
  parameterTypes: readonly number[];
  rows: object[];
  results: QueryResult<object>[];
  resultBytes: number;
  confirmed: boolean;
  command?: CommandResult;
  error?: Error;
}
function result(operation: Operation): QueryResult<object> {
  return Object.freeze({
    ...operation.command!,
    rows: Object.freeze(operation.rows),
    fields: operation.fields,
  });
}
let sessionId = 0;
const noOp = () => {};

/** One physical session. It never reconnects or hands its state to a replacement transport. */
export class PhysicalConnection {
  readonly #config: Configuration;
  readonly #id = ++sessionId;
  readonly #decoder: FrameDecoder;
  readonly #transport: Transport;
  #auth: Authenticator | undefined;
  #dead = false;
  #closing = false;
  #requestedClose = false;
  #terminationSent = false;
  #ready = false;
  #dispatches = 0;
  #backendPid = 0;
  #backendSecret: number | undefined;
  #interruption: Error | undefined;
  #cancelTask: Promise<void> | undefined;
  #cancelController: AbortController | undefined;
  #cancelError: unknown;
  #disposed = Promise.withResolvers<void>();
  #lost = new Set<() => void>();
  #info: SessionInfo | undefined;
  #parameters = new Map<string, string>();
  #status: TransactionStatus = 'idle';
  #messages: { message: Message; byteLength: number }[] = [];
  #processing = false;
  #queue: Operation[] = [];
  #active: Operation | undefined;
  #stopStartup = noOp;
  #stopClose = noOp;
  #stopCancel = noOp;
  #closePromise: Promise<void> | undefined;
  #started = Promise.withResolvers<void>();

  constructor(config: Configuration) {
    this.#config = config;
    this.#decoder = new FrameDecoder(config.maxMessageBytes);
    this.#transport = new Transport(config, {
      ready: (binding) => this.#beginStartup(binding),
      data: this.#data,
      error: (error) => this.#fail(error),
      closed: this.#socketClosed,
    });
  }

  async open(options: OperationOptions): Promise<PhysicalConnection> {
    this.#stopStartup = watchOperation(
      options,
      (error) => this.#fail(error),
      this.#config.connectTimeoutMs,
    );
    this.#transport.open();
    try {
      await this.#started.promise;
      return this;
    } catch (error) {
      await this.#disposed.promise;
      throw error;
    }
  }

  onLost(listener: () => void): () => void {
    if (this.#dead) queueMicrotask(listener);
    else this.#lost.add(listener);
    return () => {
      this.#lost.delete(listener);
    };
  }
  commit(options: OperationOptions): Promise<QueryResult<object>> {
    return this.#execute('query', () => encodeQuery('COMMIT'), options, result, true);
  }
  get dispatchCount(): number {
    return this.#dispatches;
  }
  get usable(): boolean {
    return !this.#dead && !this.#closing;
  }
  get closed(): Promise<void> {
    return this.#disposed.promise;
  }
  dispose(): void {
    this.#requestedClose = true;
    this.#fail(new DriverError('PGCLEAR_CLOSED', 'Connection disposed.'));
  }
  interrupt(error: Error): void {
    if (this.#dead || this.#interruption) return;
    if (this.#active) this.#interrupt(this.#active, error);
    else {
      this.#requestedClose = true;
      this.#fail(error);
    }
  }

  get info(): SessionInfo {
    return this.#info!;
  }
  get transactionStatus(): TransactionStatus {
    return this.#status;
  }

  #emit(event: DriverEvent): void {
    if (!this.#config.onEvent) return;
    const warn = () => process.emitWarning('pgclear observation callback failed.');
    try {
      void Promise.resolve(this.#config.onEvent(Object.freeze(event))).catch(warn);
    } catch {
      warn();
    }
  }

  #socketClosed = (): void => {
    if (!this.#dead)
      this.#fail(new DriverError('PGCLEAR_CONNECTION_LOST', 'PostgreSQL connection closed.'));
    void (this.#cancelTask ?? Promise.resolve()).then(() => this.#disposed.resolve());
  };

  #data = (chunk: Buffer): void => {
    if (this.#dead) return;
    this.#transport.pause();
    try {
      this.#decoder.push(chunk, (frame) =>
        this.#messages.push({
          message: decodeMessage(frame),
          byteLength: frame.payload.length + 5,
        }),
      );
    } catch (error) {
      this.#fail(error instanceof Error ? error : protocolError());
      return;
    }
    void this.#drainMessages();
  };

  #beginStartup(binding?: () => Buffer): void {
    this.#auth = new Authenticator(this.#config, binding);
    this.#write(startup(this.#config.startup));
  }

  #write(bytes: Buffer): void {
    if (this.#dead) return;
    this.#transport.write(bytes);
  }

  async #drainMessages(): Promise<void> {
    if (this.#processing) return;
    this.#processing = true;
    try {
      for (
        let message = this.#messages.shift();
        message && !this.#dead;
        message = this.#messages.shift()
      ) {
        await this.#receive(message.message, message.byteLength);
      }
    } catch (error) {
      this.#fail(error instanceof Error ? error : protocolError());
    } finally {
      this.#processing = false;
      if (!this.#dead) this.#transport.resume();
    }
  }

  async #receive(message: Message, byteLength: number): Promise<void> {
    if (message.type === 'error') {
      if (!this.#ready) {
        this.#fail(message.error);
        return;
      }
      if (!this.#active) {
        this.#fail(message.error);
        return;
      }
      if (
        this.#active.error instanceof DriverError &&
        this.#active.error.code === 'PGCLEAR_DECODE'
      ) {
        const decodeError = this.#active.error;
        this.#active.error = new AggregateError(
          [
            new DriverError(decodeError.code, decodeError.message, 'confirmed', {
              cause: decodeError,
            }),
            message.error,
          ],
          'Result decoding and PostgreSQL command failed.',
        );
      } else this.#active.error ??= message.error;
      this.#active.phase = 'ready';
      this.#active.confirmed = true;
      return;
    }
    if (message.type === 'notice') {
      if (this.#info) this.#emit({ type: 'notice', session: this.#info, notice: message.error });
      return;
    }
    if (message.type === 'authentication') {
      if (this.#ready || !this.#auth) throw protocolError('Unexpected authentication response.');
      const response = await this.#auth.receive(message.authentication);
      // A timed-out credential provider or PBKDF2 result cannot write to a closed socket.
      if (response && !this.#dead) this.#write(response);
      return;
    }
    if (!this.#auth?.complete && !this.#ready)
      throw protocolError('Server message arrived before authentication completed.');
    if (message.type === 'parameter') {
      if (message.name === 'client_encoding' && message.value !== 'UTF8')
        throw protocolError('Only UTF8 client encoding is supported.');
      // Ignore unknown server parameters rather than growing retained state without a bound.
      if (
        [
          'server_version',
          'client_encoding',
          'TimeZone',
          'DateStyle',
          'IntervalStyle',
          'standard_conforming_strings',
        ].includes(message.name)
      ) {
        this.#parameters.set(message.name, message.value);
      }
      return;
    }
    if (message.type === 'key') {
      if (this.#ready) throw protocolError('Unexpected backend key.');
      this.#backendPid = message.pid;
      this.#backendSecret = message.secret;
      return;
    }
    if (message.type === 'notification') return;
    if (message.type === 'ready') {
      this.#status = message.status;
      if (!this.#ready) {
        this.#ready = true;
        this.#info = Object.freeze({
          id: this.#id,
          backendPid: this.#backendPid,
          serverVersion: this.#parameters.get('server_version') ?? '',
        });
        this.#stopStartup();
        this.#auth = undefined;
        this.#started.resolve();
        this.#emit({ type: 'connect', session: this.#info });
      } else {
        const operation = this.#active;
        if (
          !operation ||
          (operation.phase !== 'ready' &&
            !(operation.kind === 'script' && operation.phase === 'script'))
        )
          throw protocolError('Unexpected ReadyForQuery.');
        if (this.#interruption) await this.#cancelTask;
        if (this.#dead) return;
        this.#active = undefined;
        let error = operation.error;
        if (this.#interruption) {
          error =
            this.#interruption instanceof DriverError
              ? new DriverError(this.#interruption.code, this.#interruption.message, 'confirmed', {
                  cause: error ?? this.#interruption,
                })
              : this.#interruption;
          if (this.#cancelError)
            error = new AggregateError(
              [error, this.#cancelError],
              'Operation interruption and cancellation cleanup failed.',
            );
        }
        this.#settle(operation, error, 'confirmed');
        this.#pump();
      }
      return;
    }
    const operation = this.#active;
    if (!operation) throw protocolError('Backend response has no owning operation.');
    if (message.type === 'command' && operation.kind === 'query') operation.confirmed = true;
    if (['fields', 'row', 'command', 'empty', 'parameters'].includes(message.type)) {
      operation.resultBytes += byteLength;
      if (operation.resultBytes > this.#config.maxResultBytes)
        throw new DriverError(
          'PGCLEAR_RESULT_LIMIT',
          'Buffered result exceeded maxResultBytes.',
          operation.confirmed ? 'confirmed' : 'unknown',
        );
    }
    if (message.type === 'parse' && operation.phase === 'parse') {
      operation.phase = operation.kind === 'describe' ? 'parameters' : 'bind';
      return;
    }
    if (
      message.type === 'parameters' &&
      operation.phase === 'parameters' &&
      operation.kind === 'describe'
    ) {
      operation.parameterTypes = message.oids;
      operation.phase = 'description';
      return;
    }
    if (message.type === 'bind' && operation.phase === 'bind') {
      operation.phase = 'description';
      return;
    }
    if (
      (message.type === 'fields' || message.type === 'no-data') &&
      (operation.phase === 'description' ||
        (operation.kind === 'script' && operation.phase === 'script' && message.type === 'fields'))
    ) {
      operation.fields = message.type === 'fields' ? message.fields : Object.freeze([]);
      if (operation.kind === 'describe') {
        operation.phase = 'ready';
        operation.confirmed = true;
        return;
      }
      operation.phase = 'rows';
      if (
        !operation.arrayMode &&
        new Set(operation.fields.map((field) => field.name)).size !== operation.fields.length
      ) {
        operation.error ??= new DriverError(
          'PGCLEAR_DECODE',
          'Duplicate column names require array row mode.',
          'unknown',
        );
      }
      return;
    }
    if (message.type === 'row' && operation.phase === 'rows') {
      if (message.values.length !== operation.fields.length)
        throw protocolError('Data row does not match its fields.');
      if (!operation.error) {
        try {
          const values = message.values.map((value, index) =>
            this.#config.codecs.decode(value, operation.fields[index]!),
          );
          if (operation.arrayMode) operation.rows.push(values);
          else {
            const row = {};
            operation.fields.forEach((field, index) =>
              Object.defineProperty(row, field.name, {
                value: values[index],
                enumerable: true,
                writable: true,
                configurable: true,
              }),
            );
            operation.rows.push(row);
          }
        } catch (cause) {
          operation.error = new DriverError(
            'PGCLEAR_DECODE',
            'Failed to decode a PostgreSQL result.',
            'unknown',
            { cause },
          );
        }
      }
      return;
    }
    if (
      (message.type === 'command' || message.type === 'empty') &&
      (operation.phase === 'rows' || (operation.kind === 'script' && operation.phase === 'script'))
    ) {
      operation.command = commandResult(message.type === 'command' ? message.tag : '');
      if (operation.kind === 'script') {
        if (!operation.error) operation.results.push(result(operation));
        operation.rows = [];
        operation.fields = Object.freeze([]);
        operation.phase = 'script';
      } else {
        operation.phase = 'ready';
        operation.confirmed = true;
      }
      return;
    }
    throw protocolError('Unexpected operation response sequence.');
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
    return this.#execute('query', () => encodeQuery(statement), options, result);
  }

  describe(
    statement: string | DescribeStatement,
    options: OperationOptions = {},
  ): Promise<Description> {
    return this.#execute(
      'describe',
      () => encodeDescribe(statement),
      options,
      (operation) =>
        Object.freeze({ parameterTypes: operation.parameterTypes, fields: operation.fields }),
    );
  }

  script(text: string, options: OperationOptions = {}): Promise<readonly QueryResult[]> {
    return this.#execute(
      'script',
      () => encodeScript(text),
      options,
      (operation) => Object.freeze(operation.results) as readonly QueryResult[],
    );
  }

  #execute<T>(
    kind: Operation['kind'],
    encode: () => Buffer,
    options: QueryOptions | ArrayQueryOptions,
    read: (operation: Operation) => T,
    commit = false,
  ): Promise<T> {
    const started = performance.now();
    return new Promise((resolve, reject) => {
      let operation: Operation | undefined;
      try {
        validateOperation(options, kind === 'query' ? ['rowMode'] : []);
        if (
          kind === 'query' &&
          options.rowMode !== undefined &&
          !['object', 'array'].includes(options.rowMode)
        )
          throw new DriverError('PGCLEAR_CONFIGURATION', 'Invalid row mode.');
        if (this.#closing || this.#dead)
          throw new DriverError('PGCLEAR_CLOSED', 'The connection is closed.');
        if (options.signal?.aborted) throw new DriverError('PGCLEAR_ABORTED', 'Operation aborted.');
        if (options.timeoutMs === 0)
          throw new DriverError('PGCLEAR_TIMEOUT', 'Operation deadline expired.');
        if (this.#queue.length >= this.#config.maxQueuedOperations)
          throw new DriverError('PGCLEAR_QUEUE_FULL', 'The connection queue is full.');
        operation = {
          kind,
          commit,
          wire: undefined,
          arrayMode: kind === 'query' && options.rowMode === 'array',
          complete: (op) => {
            try {
              resolve(read(op));
            } catch (error) {
              reject(error);
            }
          },
          reject,
          started,
          stop: noOp,
          phase: 'encoding',
          fields: Object.freeze([]),
          parameterTypes: Object.freeze([]),
          rows: [],
          results: [],
          resultBytes: 0,
          confirmed: false,
        };
        const accepted = operation;
        // Reserve FIFO position before invoking a user encoder, which may reenter this connection.
        this.#queue.push(accepted);
        accepted.stop = watchOperation(options, (error) => this.#interrupt(accepted, error));
        try {
          accepted.wire = encode();
        } catch (cause) {
          throw cause instanceof DriverError
            ? cause
            : new DriverError(
                'PGCLEAR_ENCODE',
                'Failed to encode PostgreSQL operation.',
                'not-sent',
                { cause },
              );
        }
        if (accepted.phase === 'settled') return;
        if (options.timeoutMs !== undefined && performance.now() - started >= options.timeoutMs) {
          this.#interrupt(
            accepted,
            new DriverError('PGCLEAR_TIMEOUT', 'Operation deadline expired.'),
          );
          return;
        }
        accepted.phase = 'queued';
        this.#pump();
      } catch (error) {
        if (operation && operation.phase !== 'settled')
          this.#interrupt(
            operation,
            error instanceof Error
              ? error
              : new DriverError('PGCLEAR_ENCODE', 'Operation encoding failed.'),
          );
        else reject(error);
      }
    });
  }

  #interrupt(operation: Operation, error: Error): void {
    if (operation.phase === 'settled') return;
    if (operation.phase !== 'queued' && operation.phase !== 'encoding') {
      if (this.#interruption) return;
      this.#interruption = error;
      this.#closing = this.#requestedClose = true;
      for (const queued of this.#queue.splice(0))
        this.#settle(
          queued,
          new DriverError('PGCLEAR_CLOSED', 'Connection retired before dispatch.'),
          'not-sent',
        );
      if (this.#backendSecret === undefined) {
        this.#fail(error);
        return;
      }
      this.#stopCancel = deadline(5000, () => this.#fail(error));
      this.#cancelController = new AbortController();
      this.#cancelTask = cancel(
        this.#config,
        this.#backendPid,
        this.#backendSecret,
        this.#cancelController.signal,
      ).catch((cause) => {
        this.#cancelError = cause;
        this.#fail(error);
      });
      return;
    }
    const index = this.#queue.indexOf(operation);
    if (index !== -1) this.#queue.splice(index, 1);
    this.#settle(operation, error, 'not-sent');
    this.#pump();
  }

  #pump(): void {
    if (this.#dead || this.#active) return;
    if (this.#queue[0]?.phase === 'encoding') return;
    const operation = this.#queue.shift();
    if (!operation) {
      if (this.#closing && !this.#terminationSent) {
        this.#terminationSent = true;
        this.#transport.end(terminate);
      }
      return;
    }
    this.#active = operation;
    operation.phase = operation.kind === 'script' ? 'script' : 'parse';
    this.#dispatches++;
    this.#write(operation.wire!);
  }

  #settle(operation: Operation, error: Error | undefined, outcome: Outcome): void {
    if (operation.phase === 'settled') return;
    operation.phase = 'settled';
    operation.stop();
    if (error instanceof DriverError && error.outcome !== outcome)
      error = new DriverError(error.code, error.message, outcome, { cause: error });
    if (error) operation.reject(error);
    else operation.complete(operation);
    this.#emit({
      type: 'operation',
      sessionId: this.#id,
      operation: operation.kind,
      durationMs: performance.now() - operation.started,
      outcome,
      ...(error instanceof DriverError || error instanceof DatabaseError
        ? { errorCode: error.code }
        : {}),
    });
  }

  #fail(error: Error): void {
    if (this.#dead) return;
    this.#dead = this.#closing = true;
    this.#stopStartup();
    this.#stopClose();
    this.#stopCancel();
    this.#cancelController?.abort();
    this.#started.reject(error);
    const active = this.#active;
    this.#active = undefined;
    if (active) {
      const knownCommit =
        active.commit &&
        active.command?.commandTag === 'COMMIT' &&
        !active.error &&
        !this.#interruption;
      let failure = this.#interruption ?? active.error ?? error;
      if (active.commit && !active.confirmed)
        failure = new DriverError(
          'PGCLEAR_COMMIT_UNKNOWN',
          'COMMIT was dispatched without a definitive response.',
          'unknown',
          { cause: failure },
        );
      this.#settle(
        active,
        knownCommit ? undefined : failure,
        active.confirmed ? 'confirmed' : 'unknown',
      );
    }
    for (const operation of this.#queue.splice(0)) {
      this.#settle(
        operation,
        new DriverError('PGCLEAR_CLOSED', 'The connection closed before dispatch.', 'not-sent', {
          cause: error,
        }),
        'not-sent',
      );
    }
    this.#messages = [];
    this.#auth = undefined;
    this.#parameters.clear();
    this.#backendSecret = undefined;
    this.#transport.destroy();
    for (const listener of this.#lost) listener();
    this.#lost.clear();
    if (this.#info)
      this.#emit({ type: 'disconnect', session: this.#info, expected: this.#requestedClose });
  }

  close(options: CloseOptions = {}): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    try {
      validateOperation(options);
      if ('signal' in options)
        throw new DriverError('PGCLEAR_CONFIGURATION', 'Close accepts only timeoutMs.');
      const timeout = integer(options.timeoutMs ?? 5000, 'timeoutMs', 0);
      this.#requestedClose = true;
      this.#closing = true;
      this.#closePromise = this.#disposed.promise.then(() => {
        if (this.#cancelError)
          throw new AggregateError([this.#cancelError], 'Cancellation cleanup failed.');
      });
      if (!this.#dead) {
        if (timeout === 0)
          this.#fail(new DriverError('PGCLEAR_CLOSED', 'Connection closed at its deadline.'));
        else {
          this.#stopClose = deadline(timeout, () =>
            this.#fail(new DriverError('PGCLEAR_CLOSED', 'Connection closed at its deadline.')),
          );
          this.#pump();
        }
      }
      return this.#closePromise;
    } catch (error) {
      return Promise.reject(error);
    }
  }
}

export async function openConnection(
  config: Configuration,
  operation: OperationOptions = {},
): Promise<PhysicalConnection> {
  validateOperation(operation);
  if (operation.signal?.aborted)
    throw new DriverError('PGCLEAR_ABORTED', 'Connection startup aborted.');
  if (operation.timeoutMs === 0 || config.connectTimeoutMs === 0)
    throw new DriverError('PGCLEAR_TIMEOUT', 'Connection startup deadline expired.');
  return new PhysicalConnection(config).open(operation);
}
export async function connect(
  options: string | ConnectionOptions,
  operation: OperationOptions = {},
): Promise<import('../types.js').Connection> {
  return new ConnectionHandle(await openConnection(normalizeConfiguration(options), operation));
}
