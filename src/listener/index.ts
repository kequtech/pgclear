import { setTimeout as delay } from 'node:timers/promises';
import {
  normalizeConfiguration,
  validateOperation,
  validateClose,
  type Configuration,
} from '../config/index.js';
import { openConnection, type PhysicalConnection } from '../connection/index.js';
import { CLEANUP_TIMEOUT_MS, Lifetime, abortError } from '../connection/timing.js';
import { builtin } from '../codecs/builtin.js';
import { param } from '../codecs/parameters.js';
import { DriverError, configurationError } from '../errors.js';
import { observe } from '../observe.js';
import type {
  CloseOptions,
  ConnectionOptions,
  Listener,
  ListenerOptions,
  ListenerStatus,
} from '../types.js';

const closed = () => new DriverError('PGCLEAR_CLOSED', 'The listener is closed.');

/** A stable handle owns one replaceable connection and one sequential supervision task. */
class ListenerHandle implements Listener {
  readonly #config: Configuration;
  readonly #options: ListenerOptions;
  #status: ListenerStatus = Object.freeze({ state: 'reconnecting', attempt: 0, generation: 0 });
  #connection: PhysicalConnection | undefined;
  #close: Promise<void> | undefined;
  #task: Promise<void> = Promise.resolve();
  readonly #ready = Promise.withResolvers<Listener>();
  readonly #controller = new AbortController();
  readonly #initial: Lifetime;
  readonly #signal: AbortSignal;
  readonly #abort = () => {
    void this.close().catch(() => {});
  };

  constructor(config: Configuration, options: ListenerOptions) {
    this.#config = config;
    this.#options = options;
    this.#initial = new Lifetime(options);
    this.#signal = AbortSignal.any([this.#controller.signal, this.#initial.signal]);
    void this.#ready.promise.catch(() => {});
  }
  get status(): ListenerStatus {
    return this.#status;
  }
  start(): Promise<Listener> {
    this.#signal.addEventListener('abort', this.#abort, { once: true });
    // Install the task before any observation callback can close its owner.
    this.#task = Promise.resolve().then(() => this.#run());
    if (this.#signal.aborted) this.#abort();
    return this.#ready.promise.catch(async (error: unknown) => {
      try {
        await this.close();
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'Listener setup and cleanup failed.');
      }
      throw error;
    });
  }
  #set(status: ListenerStatus): void {
    this.#status = Object.freeze(status);
    observe(this.#options.onStatus, this.#status);
  }
  async #run(): Promise<void> {
    let initial = true,
      attempt = 0;
    try {
      while (!this.#close) {
        let connection: PhysicalConnection | undefined;
        let stopLost = () => {};
        const life = new Lifetime({ signal: this.#signal }, initial ? this.#initial : undefined);
        try {
          if (attempt) {
            this.#set({ state: 'reconnecting', attempt, generation: this.#status.generation });
            const ceiling = Math.min(30000, 100 * 2 ** Math.min(attempt - 1, 9));
            await delay(ceiling * (0.5 + Math.random() * 0.5), undefined, { signal: this.#signal });
          }
          life.check();
          if (this.#close) return;
          connection = await openConnection(this.#config, { signal: life.signal }, (value) => {
            if (
              !this.#close &&
              this.#connection === connection &&
              this.#status.state === 'connected'
            )
              observe(this.#options.onNotification, value);
          });
          this.#connection = connection;
          if (this.#close) return;
          const lost = Promise.withResolvers<Error>();
          stopLost = connection.onLost(lost.resolve);
          const execute = (statement: Parameters<PhysicalConnection['query']>[0]) =>
            connection!.query(statement, { lifetime: new Lifetime({}, life) });
          // Count invalid identifiers without invoking user-configured result codecs.
          const invalid = await execute({
            text: `SELECT FROM pg_catalog.unnest($1::pg_catalog.text[]) AS channels(name)
                   WHERE pg_catalog.octet_length(name) > pg_catalog.current_setting('max_identifier_length')::pg_catalog.int4`,
            values: [param(this.#options.channels, builtin.textArray)],
          });
          if (invalid.rowCount !== 0)
            configurationError('Notification channel exceeds the server identifier limit.');
          for (const channel of this.#options.channels)
            await execute('LISTEN "' + channel.replaceAll('"', '""') + '"');
          life.check();
          if (this.#close || !connection.usable) throw closed();
          this.#initial.stop();
          attempt = 0;
          this.#set({
            state: 'connected',
            session: connection.info,
            generation: this.#status.generation + 1,
          });
          life.check();
          if (this.#close) throw closed();
          initial = false;
          this.#ready.resolve(this);
          throw await lost.promise;
        } catch (cause) {
          if (this.#close || this.#signal.aborted) {
            this.#ready.reject(this.#signal.aborted ? abortError(this.#signal) : closed());
            return;
          }
          const error =
            cause instanceof Error ? cause : new Error('Listener connection failed.', { cause });
          if (initial) {
            this.#ready.reject(error);
            void this.close().catch(() => {});
            return;
          }
          this.#set({ state: 'disconnected', error, generation: this.#status.generation });
          if (!this.#options.reconnect) {
            void this.close().catch(() => {});
            return;
          }
          attempt++;
        } finally {
          stopLost();
          life.stop();
          if (connection) {
            connection.dispose();
            await connection.closed;
          }
          if (this.#connection === connection) this.#connection = undefined;
        }
      }
    } finally {
      this.#initial.stop();
      this.#ready.reject(this.#signal.aborted ? abortError(this.#signal) : closed());
    }
  }
  close(options: CloseOptions = {}): Promise<void> {
    if (this.#close) return this.#close;
    try {
      validateClose(options);
    } catch (error) {
      return Promise.reject(error);
    }
    const completion = Promise.withResolvers<void>();
    this.#close = completion.promise;
    const connection = this.#connection;
    const graceful = this.#status.state === 'connected';
    this.#signal.removeEventListener('abort', this.#abort);
    this.#set({ state: 'closed', generation: this.#status.generation });
    const cleanup =
      connection && graceful
        ? connection.close({ timeoutMs: options.timeoutMs ?? CLEANUP_TIMEOUT_MS })
        : Promise.resolve();
    if (!graceful) connection?.dispose();
    this.#controller.abort();
    void (async () => {
      try {
        await cleanup;
      } finally {
        connection?.dispose();
        await this.#task;
      }
    })().then(completion.resolve, completion.reject);
    return this.#close;
  }
}

export async function listen(
  connection: string | ConnectionOptions,
  options: ListenerOptions,
): Promise<Listener> {
  validateOperation(options, ['channels', 'onNotification', 'onStatus', 'reconnect']);
  if (
    !Array.isArray(options.channels) ||
    options.channels.length === 0 ||
    Array.from(options.channels).some(
      (name) => typeof name !== 'string' || !name || name.includes('\0') || !name.isWellFormed(),
    ) ||
    typeof options.onNotification !== 'function' ||
    (options.onStatus !== undefined && typeof options.onStatus !== 'function') ||
    (options.reconnect !== undefined && typeof options.reconnect !== 'boolean')
  )
    configurationError('Invalid listener options.');
  const channels = Object.freeze([...new Set(options.channels)]);
  const settings = Object.freeze({ ...options, channels });
  const listener = new ListenerHandle(normalizeConfiguration(connection), settings);
  return listener.start();
}
