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
  Connection,
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
import { Transport } from '../transport/index.js';
import { commandResult, decodeValue, encodeQuery } from './query.js';
import { deadline, watchOperation } from './timing.js';

interface Operation {
  readonly wire: Buffer;
  readonly arrayMode: boolean;
  readonly resolve: (value: QueryResult<object>) => void;
  readonly reject: (error: unknown) => void;
  readonly started: number;
  stop: () => void;
  phase: 'queued' | 'parse' | 'bind' | 'description' | 'rows' | 'ready' | 'settled';
  fields: readonly Field[];
  rows: object[];
  resultBytes: number;
  command?: CommandResult;
  error?: Error;
}
let sessionId = 0;
const noOp = () => {};

/** One physical session. It never reconnects or hands its state to a replacement transport. */
class PhysicalConnection implements Connection {
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
  #backendPid = 0;
  #info: SessionInfo | undefined;
  #parameters = new Map<string, string>();
  #status: TransactionStatus = 'idle';
  #messages: Message[] = [];
  #processing = false;
  #queue: Operation[] = [];
  #active: Operation | undefined;
  #stopStartup = noOp;
  #stopClose = noOp;
  #closePromise: Promise<void> | undefined;
  #closed = Promise.withResolvers<void>();
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

  async open(options: OperationOptions): Promise<Connection> {
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
      await this.#closed.promise;
      throw error;
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
    this.#closed.resolve();
  };

  #data = (chunk: Buffer): void => {
    if (this.#dead) return;
    this.#transport.pause();
    try {
      this.#decoder.push(chunk, (frame) => this.#messages.push(decodeMessage(frame)));
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
        await this.#receive(message);
      }
    } catch (error) {
      this.#fail(error instanceof Error ? error : protocolError());
    } finally {
      this.#processing = false;
      if (!this.#dead) this.#transport.resume();
    }
  }

  async #receive(message: Message): Promise<void> {
    if (message.type === 'error') {
      if (!this.#ready) {
        this.#fail(message.error);
        return;
      }
      if (!this.#active) {
        this.#fail(message.error);
        return;
      }
      this.#active.error ??= message.error;
      this.#active.phase = 'ready';
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
      // Protocol cancellation is M3. Do not retain or expose unused cancellation secrets.
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
        if (!operation || operation.phase !== 'ready')
          throw protocolError('Unexpected ReadyForQuery.');
        this.#active = undefined;
        this.#settle(operation, operation.error, 'confirmed');
        this.#pump();
      }
      return;
    }
    const operation = this.#active;
    if (!operation) throw protocolError('Backend response has no owning operation.');
    if (message.type === 'parse' && operation.phase === 'parse') {
      operation.phase = 'bind';
      return;
    }
    if (message.type === 'bind' && operation.phase === 'bind') {
      operation.phase = 'description';
      return;
    }
    if (
      (message.type === 'fields' || message.type === 'no-data') &&
      operation.phase === 'description'
    ) {
      operation.fields = message.type === 'fields' ? message.fields : Object.freeze([]);
      operation.phase = 'rows';
      if (
        !operation.arrayMode &&
        new Set(operation.fields.map((field) => field.name)).size !== operation.fields.length
      ) {
        operation.error = new DriverError(
          'PGCLEAR_DECODE',
          'Duplicate column names require array row mode.',
          'confirmed',
        );
      }
      return;
    }
    if (message.type === 'row' && operation.phase === 'rows') {
      if (message.values.length !== operation.fields.length)
        throw protocolError('Data row does not match its fields.');
      // Include row/field framing so a stream of NULL or empty values still spends its budget.
      operation.resultBytes +=
        7 +
        4 * message.values.length +
        message.values.reduce((total, value) => total + (value?.length ?? 0), 0);
      if (operation.resultBytes > this.#config.maxResultBytes)
        throw new DriverError(
          'PGCLEAR_RESULT_LIMIT',
          'Buffered result exceeded maxResultBytes.',
          'unknown',
        );
      if (!operation.error) {
        try {
          const values = message.values.map((value, i) => decodeValue(value, operation.fields[i]!));
          if (operation.arrayMode) operation.rows.push(values);
          else {
            const row = {};
            operation.fields.forEach((field, i) =>
              Object.defineProperty(row, field.name, {
                value: values[i],
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
    if ((message.type === 'command' || message.type === 'empty') && operation.phase === 'rows') {
      operation.command = commandResult(message.type === 'command' ? message.tag : '');
      operation.phase = 'ready';
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
    return new Promise((resolve, reject) => {
      try {
        validateOperation(options, ['rowMode']);
        if (options.rowMode !== undefined && !['object', 'array'].includes(options.rowMode))
          throw new DriverError('PGCLEAR_CONFIGURATION', 'Invalid row mode.');
        if (this.#closing || this.#dead)
          throw new DriverError('PGCLEAR_CLOSED', 'The connection is closed.');
        if (options.signal?.aborted) throw new DriverError('PGCLEAR_ABORTED', 'Operation aborted.');
        if (options.timeoutMs === 0)
          throw new DriverError('PGCLEAR_TIMEOUT', 'Operation deadline expired.');
        if (this.#queue.length >= this.#config.maxQueuedOperations)
          throw new DriverError('PGCLEAR_QUEUE_FULL', 'The connection queue is full.');
        const wire = encodeQuery(statement);
        const operation: Operation = {
          wire,
          arrayMode: options.rowMode === 'array',
          resolve,
          reject,
          started: performance.now(),
          stop: noOp,
          phase: 'queued',
          fields: Object.freeze([]),
          rows: [],
          resultBytes: 0,
        };
        this.#queue.push(operation);
        operation.stop = watchOperation(options, (error) => {
          if (operation.phase === 'settled') return;
          if (operation.phase !== 'queued') {
            this.#fail(error);
            return;
          }
          this.#queue.splice(this.#queue.indexOf(operation), 1);
          this.#settle(operation, error, 'not-sent');
        });
        this.#pump();
      } catch (error) {
        reject(error);
      }
    });
  }

  #pump(): void {
    if (this.#dead || this.#active) return;
    const operation = this.#queue.shift();
    if (!operation) {
      if (this.#closing && !this.#terminationSent) {
        this.#terminationSent = true;
        this.#transport.end(terminate);
      }
      return;
    }
    this.#active = operation;
    operation.phase = 'parse';
    this.#write(operation.wire);
  }

  #settle(operation: Operation, error: Error | undefined, outcome: Outcome): void {
    if (operation.phase === 'settled') return;
    operation.phase = 'settled';
    operation.stop();
    if (error instanceof DriverError && error.outcome !== outcome)
      error = new DriverError(error.code, error.message, outcome, { cause: error });
    if (error) operation.reject(error);
    else
      operation.resolve(
        Object.freeze({
          ...operation.command!,
          rows: Object.freeze(operation.rows),
          fields: operation.fields,
        }),
      );
    this.#emit({
      type: 'operation',
      sessionId: this.#id,
      operation: 'query',
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
    this.#started.reject(error);
    const active = this.#active;
    this.#active = undefined;
    if (active) {
      const failure = active.error ?? error;
      this.#settle(
        active,
        failure,
        active.command || active.error instanceof DatabaseError ? 'confirmed' : 'unknown',
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
    this.#transport.destroy();
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
      this.#closePromise = this.#closed.promise;
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

export async function connect(
  options: string | ConnectionOptions,
  operation: OperationOptions = {},
): Promise<Connection> {
  const config = normalizeConfiguration(options);
  validateOperation(operation);
  if (operation.signal?.aborted)
    throw new DriverError('PGCLEAR_ABORTED', 'Connection startup aborted.');
  if (operation.timeoutMs === 0 || config.connectTimeoutMs === 0)
    throw new DriverError('PGCLEAR_TIMEOUT', 'Connection startup deadline expired.');
  return new PhysicalConnection(config).open(operation);
}
