import { Authenticator } from '../auth/index.js';
import {
  normalizeConfiguration,
  validateOperation,
  validateClose,
  integer,
  type Configuration,
} from '../config/index.js';
import { DatabaseError, DriverError, protocolError } from '../errors.js';
import { FrameDecoder, startup, terminate, frame, cstring } from '../protocol/framing.js';
import { decodeMessage, type Message } from '../protocol/messages.js';
import type {
  ArrayQueryOptions,
  CloseOptions,
  CommandResult,
  Description,
  DescribeStatement,
  ConnectionOptions,
  DriverEvent,
  OperationOptions,
  Outcome,
  QueryOptions,
  QueryResult,
  Row,
  SessionInfo,
  InputValue,
  QueryInput,
  TransactionStatus,
  StreamCompletion,
  CopySource,
} from '../types.js';
import { ConnectionHandle } from '../session/index.js';
import { cancel } from '../transport/cancel.js';
import { Transport } from '../transport/index.js';
import {
  commandResult,
  encodeDescribe,
  encodeQuery,
  encodeScript,
  encodePreparedQuery,
  encodeStatementClose,
  encodePortalExecute,
  encodePortalClose,
  sync,
} from './query.js';
import { PortalStream, OutputStream } from './stream.js';
import { rows, result, output, bytes, decodeRow, type Operation, type Work } from './operation.js';
import { CopyInput } from './copy.js';
import { CLEANUP_TIMEOUT_MS, deadline, Lifetime, type ExecutionOptions } from './timing.js';

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
  #dispatches = 0;
  #statementId = 0;
  #backendPid = 0;
  #backendSecret: number | undefined;
  #interruption: Error | undefined;
  #cancelTask: Promise<void> | undefined;
  #cancelController: AbortController | undefined;
  #cancelError: unknown;
  #disposed = Promise.withResolvers<void>();
  #lost = new Set<() => void>();
  #info: SessionInfo | undefined;
  #serverVersion = '';
  #status: TransactionStatus = 'idle';
  #messages: ({ message: Message; byteLength: number } | undefined)[] = [];
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
    this.#stopStartup = new Lifetime(
      options,
      undefined,
      performance.now() + this.#config.connectTimeoutMs,
    ).watch((error) => this.#fail(error));
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
  commit(options: ExecutionOptions): Promise<QueryResult<object>> {
    return this.#execute(
      { kind: 'query', phase: 'parse', result: rows(), commit: true },
      () => encodeQuery('COMMIT'),
      options,
      result,
    );
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
      let index = 0;
      while (!this.#dead && index < this.#messages.length) {
        const entry = this.#messages[index]!;
        this.#messages[index++] = undefined;
        await this.#receive(entry.message, entry.byteLength);
      }
    } catch (error) {
      this.#fail(error instanceof Error ? error : protocolError());
    } finally {
      this.#messages = [];
      this.#processing = false;
      if (!this.#dead) this.#transport.resume();
    }
  }

  async #receive(message: Message, byteLength: number): Promise<void> {
    switch (message.type) {
      case 'error':
        this.#databaseError(message.error);
        return;
      case 'notice':
        if (this.#info) this.#emit({ type: 'notice', session: this.#info, notice: message.error });
        return;
      case 'authentication': {
        if (this.#info || !this.#auth) throw protocolError('Unexpected authentication response.');
        const reply = await this.#auth.receive(message.authentication);
        if (reply && !this.#dead) this.#write(reply);
        return;
      }
    }
    if (!this.#auth?.complete && !this.#info)
      throw protocolError('Server message arrived before authentication completed.');
    switch (message.type) {
      case 'parameter':
        if (message.name === 'client_encoding' && message.value !== 'UTF8')
          throw protocolError('Only UTF8 client encoding is supported.');
        if (message.name === 'server_version') this.#serverVersion = message.value;
        return;
      case 'key':
        if (this.#info) throw protocolError('Unexpected backend key.');
        this.#backendPid = message.pid;
        this.#backendSecret = message.secret;
        return;
      case 'notification':
        return;
      case 'ready':
        await this.#receiveReady(message.status);
        return;
    }
    const op = this.#active;
    if (!op) throw protocolError('Backend response has no owning operation.');
    const work = op.work;
    if (message.type === 'command' && work.kind !== 'script') op.confirmed = true;
    if (
      ['fields', 'row', 'command', 'empty', 'parameters', 'copy-in', 'copy-out'].includes(
        message.type,
      ) &&
      bytes(work, byteLength) > this.#config.maxResultBytes
    )
      throw new DriverError(
        'PGCLEAR_RESULT_LIMIT',
        'Buffered result exceeded maxResultBytes.',
        op.confirmed ? 'confirmed' : 'unknown',
      );

    if (message.type === 'parse' && work.phase === 'parse') {
      work.phase = work.kind === 'describe' || work.kind === 'prepare' ? 'parameters' : 'bind';
      return;
    }
    if (message.type === 'parameters' && work.phase === 'parameters') {
      work.description = { ...work.description, parameterTypes: message.oids };
      work.phase = 'description';
      return;
    }
    if (message.type === 'bind' && work.phase === 'bind') {
      work.phase = 'description';
      return;
    }
    if (message.type === 'close' && work.phase === 'close') {
      work.phase = 'ready';
      op.confirmed = true;
      return;
    }
    if (
      (message.type === 'fields' || message.type === 'no-data') &&
      (work.phase === 'description' ||
        (work.kind === 'script' && work.phase === 'script' && message.type === 'fields'))
    ) {
      const fields = message.type === 'fields' ? message.fields : Object.freeze([]);
      if (work.kind === 'describe' || work.kind === 'prepare') {
        work.description = { ...work.description, fields };
        work.phase = 'ready';
        op.confirmed = true;
      } else if (work.kind === 'copy-from' || work.kind === 'copy-to') {
        work.columns = fields.length;
        work.phase = message.type === 'no-data' ? 'copy-start' : 'rows';
        if (message.type === 'fields')
          op.error = new DriverError('PGCLEAR_CONFIGURATION', 'COPY requires a COPY statement.');
      } else if ('result' in work) {
        work.result.fields = fields;
        work.phase = 'rows';
        if (work.kind === 'stream') {
          work.metadataBytes = work.result.bytes;
          work.output.metadata(fields);
        }
        if (
          !work.result.arrayMode &&
          new Set(fields.map((field) => field.name)).size !== fields.length
        )
          op.error ??= new DriverError(
            'PGCLEAR_DECODE',
            'Duplicate column names require array row mode.',
            'unknown',
          );
      } else throw protocolError();
      return;
    }
    if (message.type === 'row' && work.phase === 'rows') {
      const columns = 'result' in work ? work.result.fields.length : work.columns;
      if (message.values.length !== columns)
        throw protocolError('Data row does not match its fields.');
      if (work.kind === 'stream' && ++work.batchRows > work.batchSize)
        throw protocolError('Portal exceeded its requested batch size.');
      if ('result' in work && !op.error && !this.#interruption && !output(work)?.closing) {
        try {
          work.result.rows.push(
            decodeRow(
              message.values,
              work.result.fields,
              this.#config.codecs,
              work.result.arrayMode,
            ),
          );
        } catch (cause) {
          op.error = new DriverError(
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
      (message.type === 'copy-in' || message.type === 'copy-out') &&
      work.phase === 'copy-start'
    ) {
      work.phase = message.type;
      this.#expired(op);
      if (message.type === 'copy-in') {
        if (this.#interruption) this.#copyFail(op, this.#interruption);
        else if (work.kind !== 'copy-from')
          this.#copyFail(
            op,
            new DriverError('PGCLEAR_CONFIGURATION', 'COPY TO requires COPY ... TO STDOUT.'),
          );
        else
          void work.input
            .run((data) => this.#copyWrite(op, data))
            .then(
              () => {
                if (
                  op.state !== 'active' ||
                  work.phase !== 'copy-in' ||
                  this.#interruption ||
                  this.#expired(op)
                )
                  return;
                work.phase = 'copy-done';
                this.#write(Buffer.concat([frame('c'), frame('H')]));
              },
              (error) => this.#copyFail(op, error),
            );
      } else if (work.kind !== 'copy-to')
        this.#interrupt(
          op,
          new DriverError('PGCLEAR_CONFIGURATION', 'COPY FROM requires COPY ... FROM STDIN.'),
        );
      return;
    }
    if (message.type === 'copy-data' && work.phase === 'copy-out') {
      if (byteLength + work.bytes > this.#config.maxResultBytes)
        throw new DriverError('PGCLEAR_RESULT_LIMIT', 'COPY output chunk exceeded maxResultBytes.');
      if (!this.#expired(op) && !this.#interruption && work.kind === 'copy-to')
        await work.output.publish([new Uint8Array(message.bytes)]);
      return;
    }
    if (message.type === 'copy-done' && work.phase === 'copy-out') {
      work.phase = 'copy-done';
      return;
    }
    if (message.type === 'suspended' && work.kind === 'stream' && work.phase === 'rows') {
      if (work.batchRows !== work.batchSize)
        throw protocolError('Portal suspended before filling its requested batch.');
      work.phase = 'suspended';
      await this.#publish(op, false);
      if (op.state !== 'active') return;
      if (work.output.closing || op.error || this.#interruption || this.#expired(op))
        this.#sync(op, true);
      else {
        work.result.bytes = work.metadataBytes;
        work.batchRows = 0;
        work.phase = 'rows';
        this.#write(encodePortalExecute(work.batchSize));
      }
      return;
    }
    if (
      (message.type === 'command' || message.type === 'empty') &&
      (work.phase === 'rows' ||
        work.phase === 'copy-done' ||
        work.phase === 'copy-start' ||
        (work.kind === 'script' && work.phase === 'script'))
    ) {
      op.command = commandResult(message.type === 'command' ? message.tag : '');
      if (work.kind === 'script') {
        if (!op.error) work.results.push(result(op));
        work.result.rows = [];
        work.result.fields = Object.freeze([]);
        work.phase = 'script';
      } else if (work.kind === 'stream') {
        await this.#publish(op, true);
        if (op.state === 'active') {
          this.#expired(op);
          this.#sync(op);
        }
      } else if (work.kind === 'copy-from' || work.kind === 'copy-to') {
        if (work.phase !== 'copy-done')
          op.error ??= new DriverError(
            'PGCLEAR_CONFIGURATION',
            'COPY requires a matching COPY statement.',
          );
        else if (op.command.command !== 'COPY')
          throw protocolError('COPY ended without its command tag.');
        this.#sync(op);
      } else work.phase = 'ready';
      return;
    }
    throw protocolError('Unexpected operation response sequence.');
  }

  #databaseError(error: DatabaseError): void {
    const op = this.#active;
    if (!this.#info || !op) {
      this.#fail(error);
      return;
    }
    const work = op.work;
    if (op.error instanceof DriverError && op.error.code === 'PGCLEAR_DECODE')
      op.error = new AggregateError(
        [new DriverError(op.error.code, op.error.message, 'confirmed', { cause: op.error }), error],
        'Result decoding and PostgreSQL command failed.',
      );
    else op.error ??= error;
    op.confirmed = true;
    output(work)?.discard();
    if (work.kind === 'copy-from') void work.input.stop();
    if (work.phase === 'close') {
      this.#fail(error);
      return;
    }
    if (work.kind === 'stream' || work.kind === 'copy-from' || work.kind === 'copy-to') {
      if (work.phase !== 'ready' && work.phase !== 'copy-fail') this.#sync(op);
    }
    work.phase = 'ready';
  }

  async #receiveReady(status: TransactionStatus): Promise<void> {
    this.#status = status;
    if (!this.#info) {
      this.#info = Object.freeze({
        id: this.#id,
        backendPid: this.#backendPid,
        serverVersion: this.#serverVersion,
      });
      this.#stopStartup();
      this.#auth = undefined;
      this.#started.resolve();
      this.#emit({ type: 'connect', session: this.#info });
      return;
    }
    const op = this.#active;
    if (
      !op ||
      (op.work.phase !== 'ready' && !(op.work.kind === 'script' && op.work.phase === 'script'))
    )
      throw protocolError('Unexpected ReadyForQuery.');
    if (this.#interruption) await this.#cancelTask;
    if (this.#dead) return;
    let unsafe = false;
    if (op.work.kind === 'copy-from') {
      this.#cleanup(op);
      try {
        await Promise.race([op.work.input.stop(), this.closed]);
      } catch (cleanup) {
        op.error = new AggregateError(
          [...(op.error ? [op.error] : []), cleanup],
          'COPY and source cleanup failed.',
        );
        unsafe = true;
      }
      if (this.#dead) return;
    }
    let error = op.error;
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
    if (
      op.work.kind === 'copy-to' &&
      op.work.closedByUser &&
      !this.#cancelError &&
      (!op.error || (op.error instanceof DatabaseError && op.error.code === '57014'))
    )
      error = undefined;
    if (unsafe) this.#closing = this.#requestedClose = true;
    this.#active = undefined;
    this.#settle(op, error, 'confirmed');
    if (unsafe) this.#fail(error!);
    else this.#pump();
  }

  async #publish(op: Operation, last: boolean): Promise<void> {
    const work = op.work;
    if (work.kind !== 'stream') return;
    const batch = work.result.rows;
    work.result.rows = [];
    if (!op.error && !this.#interruption) await work.output.publish(batch, last);
  }
  #sync(op: Operation, close = false): void {
    if (op.state !== 'active' || op.work.phase === 'ready' || op.work.phase === 'close') return;
    this.#cleanup(op);
    if (close && op.work.kind === 'stream') {
      op.work.phase = 'close';
      this.#write(encodePortalClose());
    } else {
      op.work.phase = 'ready';
      this.#write(sync);
    }
  }
  #cleanup(op: Operation, end = performance.now() + CLEANUP_TIMEOUT_MS): void {
    if (op.cleanupEnd !== undefined && op.cleanupEnd <= end) return;
    op.stopCleanup?.();
    op.cleanupEnd = end;
    op.stopCleanup = deadline(Math.max(0, end - performance.now()), () => {
      const error = new DriverError('PGCLEAR_TIMEOUT', 'Resource cleanup deadline expired.');
      if (op.error)
        op.error = new AggregateError([op.error, error], 'Operation and resource cleanup failed.');
      this.#fail(error);
    });
  }
  #closeOutput(op: Operation, end?: number): void {
    if (op.state === 'settled') return;
    if (op.state !== 'active') {
      const index = this.#queue.indexOf(op);
      if (index !== -1) this.#queue.splice(index, 1);
      this.#settle(op, undefined, 'not-sent');
      this.#pump();
      return;
    }
    this.#cleanup(op, end);
    if (op.work.kind === 'copy-to') {
      op.work.closedByUser = !this.#interruption;
      this.#interrupt(op, new DriverError('PGCLEAR_ABORTED', 'COPY output closed.'));
    }
  }
  async #copyWrite(op: Operation, data: Uint8Array): Promise<void> {
    const work = op.work,
      size = Math.min(65536, this.#config.maxMessageBytes - 4);
    if (work.kind !== 'copy-from') return;
    if (size < 1) throw new DriverError('PGCLEAR_ENCODE', 'maxMessageBytes cannot hold COPY data.');
    for (let index = 0; index < data.length || (index === 0 && data.length === 0); index += size) {
      if (
        op.state !== 'active' ||
        work.phase !== 'copy-in' ||
        work.input.stopped ||
        this.#interruption ||
        this.#expired(op)
      )
        return;
      await this.#transport.send(frame('d', data.subarray(index, index + size)));
    }
  }
  #copyFail(op: Operation, error: Error): void {
    const work = op.work;
    if (op.state !== 'active' || work.phase !== 'copy-in') return;
    op.error ??= error;
    if (work.kind === 'copy-from') void work.input.stop();
    this.#cleanup(op);
    work.phase = 'copy-fail';
    this.#write(Buffer.concat([frame('f', cstring('pgclear COPY source failed.')), sync]));
  }

  query(
    statement: QueryInput<object>,
    options: ExecutionOptions = { lifetime: new Lifetime() },
  ): Promise<QueryResult<object>> {
    return this.#execute(
      { kind: 'query', phase: 'parse', result: rows(options.rowMode === 'array') },
      () => encodeQuery(statement),
      options,
      result,
    );
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
    return this.query([text, values], { ...options, lifetime: new Lifetime(options) });
  }
  describe(
    statement: string | DescribeStatement,
    options: ExecutionOptions = { lifetime: new Lifetime() },
  ): Promise<Description> {
    return this.#describe('describe', statement, '', options);
  }
  prepare(
    name: string,
    statement: string | DescribeStatement,
    options: ExecutionOptions,
  ): Promise<Description> {
    return this.#describe('prepare', statement, name, options);
  }
  #describe(
    kind: 'describe' | 'prepare',
    statement: string | DescribeStatement,
    name: string,
    options: ExecutionOptions,
  ): Promise<Description> {
    const work: Work = {
      kind,
      phase: 'parse',
      description: { fields: Object.freeze([]), parameterTypes: Object.freeze([]) },
      bytes: 0,
    };
    return this.#execute(
      work,
      () => encodeDescribe(statement, name),
      options,
      () => Object.freeze(work.description),
    );
  }
  allocateStatementName(): string {
    return 'pgclear_statement_' + ++this.#statementId;
  }
  preparedQuery(
    name: string,
    values: readonly InputValue[],
    description: Description,
    options: ExecutionOptions,
  ): Promise<QueryResult<object>> {
    return this.#execute(
      { kind: 'query', phase: 'bind', result: rows(options.rowMode === 'array') },
      () => encodePreparedQuery(name, values, description.parameterTypes),
      options,
      result,
    );
  }
  closeStatement(
    name: string,
    options: ExecutionOptions = { lifetime: new Lifetime() },
  ): Promise<void> {
    return this.#execute(
      { kind: 'statement-close', phase: 'close' },
      () => encodeStatementClose(name),
      options,
      () => {},
    );
  }
  script(
    text: string,
    options: ExecutionOptions = { lifetime: new Lifetime() },
  ): Promise<readonly QueryResult[]> {
    const work: Work = { kind: 'script', phase: 'script', result: rows(), results: [] };
    return this.#execute(
      work,
      () => encodeScript(text),
      options,
      () => Object.freeze(work.results) as readonly QueryResult[],
    );
  }
  stream(statement: QueryInput<object>, options: ExecutionOptions, stream: PortalStream): void {
    const batchSize = options.batchSize === undefined ? 100 : options.batchSize;
    const work: Work = {
      kind: 'stream',
      phase: 'parse',
      result: rows(options.rowMode === 'array'),
      output: stream,
      batchSize,
      metadataBytes: 0,
      batchRows: 0,
    };
    this.#output(
      work,
      () => {
        integer(batchSize, 'batchSize', 1, 0x7fffffff);
        return encodeQuery(statement, { batchSize });
      },
      options,
    );
  }
  copyTo(text: string, options: ExecutionOptions, stream: OutputStream<Uint8Array>): void {
    this.#output(
      { kind: 'copy-to', phase: 'parse', output: stream, bytes: 0, columns: 0 },
      () => this.#encodeCopy(text),
      options,
    );
  }
  copyFrom(text: string, source: CopySource, options: ExecutionOptions): Promise<CommandResult> {
    const input = new CopyInput(source);
    return this.#execute(
      { kind: 'copy-from', phase: 'parse', input, bytes: 0, columns: 0 },
      () => {
        input.validate();
        return this.#encodeCopy(text);
      },
      options,
      (op) => op.command!,
    );
  }
  #encodeCopy(text: string): Buffer {
    if (typeof text !== 'string')
      throw new DriverError('PGCLEAR_ENCODE', 'COPY requires SQL text.');
    return encodeQuery(text, { flush: true });
  }
  #output(
    work: Extract<Work, { kind: 'stream' | 'copy-to' }>,
    encode: () => Buffer,
    options: ExecutionOptions,
  ): void {
    const promise = this.#execute<StreamCompletion>(work, encode, options, (op) =>
      work.output.closing ? { status: 'closed' } : { status: 'complete', result: op.command! },
    );
    void promise.then(
      (value) => work.output.finish(value),
      (error) => work.output.fail(error),
    );
  }

  #execute<T>(
    work: Work,
    encode: () => Buffer,
    options: ExecutionOptions,
    read: (operation: Operation) => T,
  ): Promise<T> {
    const started = performance.now();
    return new Promise((resolve, reject) => {
      let op: Operation | undefined;
      try {
        if (!this.usable) throw new DriverError('PGCLEAR_CLOSED', 'The connection is closed.');
        options.lifetime.check();
        if (this.#queue.length >= this.#config.maxQueuedOperations)
          throw new DriverError('PGCLEAR_QUEUE_FULL', 'The connection queue is full.');
        const accepted: Operation = (op = {
          work,
          state: 'encoding',
          started,
          lifetime: options.lifetime,
          resolve: (operation) => {
            try {
              resolve(read(operation));
            } catch (error) {
              reject(error);
            }
          },
          reject,
          stop: noOp,
          confirmed: false,
        });
        // Reservation precedes any user encoder or source getter, including reentrant calls.
        this.#queue.push(accepted);
        output(work)?.onClose((end) => this.#closeOutput(accepted, end));
        accepted.stop = accepted.lifetime.watch((error) => this.#interrupt(accepted, error));
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
        if (accepted.state === 'settled' || this.#expired(accepted)) return;
        accepted.state = 'queued';
        this.#pump();
      } catch (error) {
        if (op && op.state !== 'settled')
          this.#interrupt(
            op,
            error instanceof Error
              ? error
              : new DriverError('PGCLEAR_ENCODE', 'Operation encoding failed.'),
          );
        else {
          options.lifetime.stop();
          if (work.kind === 'copy-from') void work.input.stop();
          reject(error);
        }
      }
    });
  }
  #expired(op: Operation): boolean {
    try {
      op.lifetime.check();
      return false;
    } catch (error) {
      this.#interrupt(op, error as DriverError);
      return true;
    }
  }
  #interrupt(op: Operation, error: Error): void {
    if (op.state === 'settled') return;
    if (op.state === 'active') {
      if (this.#interruption) return;
      this.#interruption = error;
      this.#closing = this.#requestedClose = true;
      output(op.work)?.discard();
      if (op.work.kind === 'copy-from') void op.work.input.stop();
      if (op.work.phase === 'copy-in') this.#copyFail(op, error);
      if (this.#dead) return;
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
      this.#stopCancel = deadline(CLEANUP_TIMEOUT_MS, () => this.#fail(error));
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
    } else {
      const index = this.#queue.indexOf(op);
      if (index !== -1) this.#queue.splice(index, 1);
      this.#settle(op, error, 'not-sent');
      this.#pump();
    }
  }
  #pump(): void {
    while (!this.#dead && !this.#active && this.#queue[0]?.state !== 'encoding') {
      const op = this.#queue.shift();
      if (!op) {
        if (this.#closing && !this.#terminationSent) {
          this.#terminationSent = true;
          this.#transport.end(terminate);
        }
        return;
      }
      try {
        op.lifetime.check();
      } catch (error) {
        this.#settle(op, error as DriverError, 'not-sent');
        continue;
      }
      this.#active = op;
      op.state = 'active';
      this.#dispatches++;
      this.#write(op.wire!);
    }
  }
  #settle(op: Operation, error: Error | undefined, outcome: Outcome): void {
    if (op.state === 'settled') return;
    op.state = 'settled';
    op.stop();
    op.stopCleanup?.();
    if (op.work.kind === 'copy-from') void op.work.input.stop();
    output(op.work)?.discard();
    if (error instanceof DriverError && error.outcome !== outcome)
      error = new DriverError(error.code, error.message, outcome, { cause: error });
    if (error) op.reject(error);
    else op.resolve(op);
    this.#emit({
      type: 'operation',
      sessionId: this.#id,
      operation: op.work.kind,
      durationMs: performance.now() - op.started,
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
    const op = this.#active;
    this.#active = undefined;
    if (op) {
      const commit = op.work.kind === 'query' && op.work.commit;
      const known =
        commit && op.command?.commandTag === 'COMMIT' && !op.error && !this.#interruption;
      let failure = this.#interruption ?? op.error ?? error;
      if (commit && !op.confirmed)
        failure = new DriverError(
          'PGCLEAR_COMMIT_UNKNOWN',
          'COMMIT was dispatched without a definitive response.',
          'unknown',
          { cause: failure },
        );
      this.#settle(op, known ? undefined : failure, op.confirmed ? 'confirmed' : 'unknown');
    }
    for (const queued of this.#queue.splice(0))
      this.#settle(
        queued,
        new DriverError('PGCLEAR_CLOSED', 'The connection closed before dispatch.', 'not-sent', {
          cause: error,
        }),
        'not-sent',
      );
    this.#messages = [];
    this.#auth = undefined;
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
      validateClose(options);
      const timeout = options.timeoutMs ?? CLEANUP_TIMEOUT_MS;
      this.#requestedClose = this.#closing = true;
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
