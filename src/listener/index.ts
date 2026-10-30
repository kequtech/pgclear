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
  OperationOptions,
} from '../types.js';

const closed = () => new DriverError('PGCLEAR_CLOSED', 'The listener is closed.');
function channelName(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || value.includes('\0') || !value.isWellFormed())
    configurationError('Invalid notification channel.');
}
function identifier(channel: string): string {
  return '"' + channel.replaceAll('"', '""') + '"';
}
interface Membership {
  readonly channel: string;
  readonly subscribe: boolean;
  readonly lifetime: Lifetime;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  stop: () => void;
  pending: boolean;
  dispatched: boolean;
}

/** A stable handle owns one replaceable connection and one sequential supervision task. */
class ListenerHandle implements Listener {
  readonly #config: Configuration;
  readonly #options: ListenerOptions;
  readonly #channels: Set<string>;
  readonly #memberships: Membership[] = [];
  #active: Membership | undefined;
  #changed = Promise.withResolvers<void>();
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
    this.#channels = new Set(options.channels);
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
  subscribe(channel: string, options: OperationOptions = {}): Promise<void> {
    return this.#membership(channel, true, options);
  }
  unsubscribe(channel: string, options: OperationOptions = {}): Promise<void> {
    return this.#membership(channel, false, options);
  }
  #wake(): void {
    this.#changed.resolve();
    this.#changed = Promise.withResolvers<void>();
  }
  #settle(request: Membership, error?: unknown): void {
    if (!request.pending) return;
    request.pending = false;
    request.stop();
    const index = this.#memberships.indexOf(request);
    if (index !== -1) this.#memberships.splice(index, 1);
    if (error === undefined) request.resolve();
    else request.reject(error);
    this.#wake();
  }
  #membership(channel: string, subscribe: boolean, options: OperationOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      let lifetime: Lifetime | undefined;
      try {
        channelName(channel);
        validateOperation(options);
        if (this.#close) throw closed();
        lifetime = new Lifetime(options);
        lifetime.check();
        const request: Membership = {
          channel,
          subscribe,
          lifetime,
          resolve,
          reject,
          stop: () => {},
          pending: true,
          dispatched: false,
        };
        request.stop = lifetime.watch((error) => {
          // Once bytes may have reached PostgreSQL, replace the session rather than leave an
          // untracked LISTEN/UNLISTEN on a reusable connection. Acknowledged membership is retained.
          const active = this.#active === request && request.dispatched;
          this.#settle(
            request,
            new DriverError(error.code, error.message, active ? 'unknown' : 'not-sent', {
              cause: error,
            }),
          );
          if (active) this.#connection?.dispose();
        });
        this.#memberships.push(request);
        this.#wake();
      } catch (error) {
        lifetime?.stop();
        reject(error);
      }
    });
  }
  async #validateChannels(
    connection: PhysicalConnection,
    channels: readonly string[],
    life: Lifetime,
  ): Promise<void> {
    // Count rows instead of decoding a scalar with application-configured codecs.
    const invalid = await connection.query(
      {
        text: `SELECT FROM pg_catalog.unnest($1::pg_catalog.text[]) AS channels(name)
             WHERE pg_catalog.octet_length(name) > pg_catalog.current_setting('max_identifier_length')::pg_catalog.int4`,
        values: [param(channels, builtin.textArray)],
      },
      { lifetime: new Lifetime({}, life) },
    );
    if (invalid.rowCount !== 0)
      configurationError('Notification channel exceeds the server identifier limit.');
  }
  async #apply(
    connection: PhysicalConnection,
    request: Membership,
    parent: Lifetime,
  ): Promise<void> {
    this.#active = request;
    const life = new Lifetime({ signal: request.lifetime.signal }, parent);
    try {
      request.lifetime.check();
      life.check();
      request.dispatched = true;
      await this.#validateChannels(connection, [request.channel], life);
      life.check();
      if (this.#channels.has(request.channel) !== request.subscribe) {
        await connection.query(
          (request.subscribe ? 'LISTEN ' : 'UNLISTEN ') + identifier(request.channel),
          { lifetime: new Lifetime({}, life) },
        );
        life.check();
        if (request.subscribe) this.#channels.add(request.channel);
        else this.#channels.delete(request.channel);
      }
      this.#settle(request);
    } catch (error) {
      // Transport loss leaves an uncancelled request queued for the next connection. A local
      // validation/server error rejects just this request on an otherwise usable connection.
      if (!connection.usable) throw error;
      this.#settle(request, error);
    } finally {
      this.#active = undefined;
      request.dispatched = false;
      life.stop();
    }
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
        let lost: Error | undefined;
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
              this.#status.state === 'connected' &&
              (this.#channels.has(value.channel) ||
                (this.#active?.subscribe && this.#active.channel === value.channel))
            )
              observe(this.#options.onNotification, value);
          });
          this.#connection = connection;
          if (this.#close) return;
          stopLost = connection.onLost((error) => {
            lost = error;
            this.#wake();
          });
          const channels = [...this.#channels];
          await this.#validateChannels(connection, channels, life);
          for (const channel of channels)
            await connection.query('LISTEN ' + identifier(channel), {
              lifetime: new Lifetime({}, life),
            });
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
          const connected = new Lifetime({ signal: this.#signal });
          while (!this.#close) {
            connected.check();
            if (lost) throw lost;
            const request = this.#memberships[0];
            if (request) await this.#apply(connection, request, connected);
            else await this.#changed.promise;
          }
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
            for (const request of [...this.#memberships]) this.#settle(request, error);
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
    for (const request of [...this.#memberships]) this.#settle(request, closed());
    this.#wake();
    const connection = this.#connection;
    // Pending membership is rejected at the close fence; no remote acknowledgement is needed.
    const graceful = this.#status.state === 'connected' && !this.#active;
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
