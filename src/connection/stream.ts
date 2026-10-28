import { DriverError } from '../errors.js';
import type { Field, RowStream, StreamCompletion } from '../types.js';

type State = 'open' | 'closing' | 'done' | { readonly error: unknown };

/** One producer, one consumer, one batch. publish waits for consumption or the next batch's demand. */
export class OutputStream<T> implements AsyncIterable<T> {
  readonly #completion = Promise.withResolvers<StreamCompletion>();
  readonly completion = this.#completion.promise;
  #state: State = 'open';
  #batch: { items: readonly T[]; index: number; last: boolean; consumed: () => void } | undefined;
  #changed = Promise.withResolvers<void>();
  #consumer = false;
  #reading = false;
  #stop: (end?: number) => void = () => {};
  #close: Promise<void> | undefined;

  constructor() {
    void this.completion.catch(() => {});
  }
  get closing(): boolean {
    return this.#state === 'closing';
  }
  get settled(): boolean {
    return this.#state === 'done' || typeof this.#state === 'object';
  }
  onClose(stop: (end?: number) => void): void {
    this.#stop = stop;
  }
  async publish(items: readonly T[], last = false): Promise<void> {
    if (this.#state !== 'open' || items.length === 0) return;
    const consumed = Promise.withResolvers<void>();
    this.#batch = { items, index: 0, last, consumed: consumed.resolve };
    this.#wake();
    await consumed.promise;
  }
  discard(): void {
    const batch = this.#batch;
    this.#batch = undefined;
    batch?.consumed();
    this.#wake();
  }
  finish(completion: StreamCompletion): void {
    if (this.settled) return;
    this.#state = 'done';
    this.#stop = () => {};
    this.#completion.resolve(Object.freeze(completion));
    this.#wake();
  }
  fail(error: unknown): void {
    if (this.settled) return;
    this.#state = { error };
    this.#stop = () => {};
    this.discard();
    this.#completion.reject(error);
  }
  close(end?: number): Promise<void> {
    if (this.#close) return this.#close;
    this.#close = this.completion.then(() => {});
    void this.#close.catch(() => {});
    if (!this.settled) {
      this.#state = 'closing';
      this.discard();
      this.#stop(end);
    }
    return this.#close;
  }
  #wake(): void {
    this.#changed.resolve();
    this.#changed = Promise.withResolvers<void>();
  }
  async #next(): Promise<IteratorResult<T>> {
    if (this.#reading)
      throw new DriverError('PGCLEAR_BUSY', 'Only one stream read may be pending.');
    this.#reading = true;
    try {
      for (;;) {
        if (typeof this.#state === 'object') throw this.#state.error;
        const batch = this.#batch;
        if (batch && batch.index < batch.items.length) {
          const value = batch.items[batch.index++]!;
          if (batch.last && batch.index === batch.items.length) this.discard();
          return { done: false, value };
        }
        if (batch) this.discard();
        if (this.settled) return { done: true, value: undefined };
        await this.#changed.promise;
      }
    } finally {
      this.#reading = false;
    }
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.#consumer) throw new DriverError('PGCLEAR_BUSY', 'A stream has only one consumer.');
    this.#consumer = true;
    return {
      next: () => this.#next(),
      return: async () => {
        await this.close();
        return { done: true, value: undefined };
      },
      throw: async (error: unknown) => {
        await this.close();
        throw error;
      },
    };
  }
}

/** Row streams add only metadata; fetching and COPY framing belong to the protocol operation. */
export class PortalStream extends OutputStream<object> implements RowStream<object> {
  readonly #fields = Promise.withResolvers<readonly Field[]>();
  readonly fields = this.#fields.promise;
  constructor() {
    super();
    void this.fields.catch(() => {});
  }
  metadata(fields: readonly Field[]): void {
    this.#fields.resolve(fields);
  }
  #abortMetadata(): void {
    this.#fields.reject(
      new DriverError('PGCLEAR_ABORTED', 'Stream closed before metadata arrived.'),
    );
  }
  override finish(completion: StreamCompletion): void {
    this.#abortMetadata();
    super.finish(completion);
  }
  override fail(error: unknown): void {
    this.#fields.reject(error);
    super.fail(error);
  }
  override close(end?: number): Promise<void> {
    this.#abortMetadata();
    return super.close(end);
  }
}
