import { Readable } from 'node:stream';
import { DriverError } from '../errors.js';
import type { CopySource } from '../types.js';

/** Source iteration is an ordinary async task. Its owner bounds return() and fences late results. */
export class CopyInput {
  #state: 'pending' | 'running' | 'ended' | 'stopped' = 'pending';
  #iterator: AsyncIterator<Uint8Array> | undefined;
  #cleanup: Promise<void> | undefined;
  constructor(readonly source: CopySource) {}
  get stopped(): boolean {
    return this.#state === 'stopped';
  }
  validate(): void {
    if (!this.source || typeof this.source[Symbol.asyncIterator] !== 'function')
      throw new DriverError(
        'PGCLEAR_CONFIGURATION',
        'COPY FROM requires an async iterable of bytes.',
      );
  }
  async run(write: (bytes: Uint8Array) => Promise<void>): Promise<void> {
    if (this.stopped) return;
    this.#state = 'running';
    try {
      this.#iterator = this.source[Symbol.asyncIterator]();
      while (!this.stopped) {
        const item = await this.#iterator.next();
        if (this.stopped) return;
        if (!item || typeof item !== 'object') throw new Error('Invalid COPY iterator result.');
        if (item.done) {
          this.#state = 'ended';
          return;
        }
        if (!(item.value instanceof Uint8Array))
          throw new DriverError('PGCLEAR_ENCODE', 'COPY source chunks must be Uint8Array.');
        await write(item.value);
      }
    } catch (cause) {
      if (!this.stopped)
        throw cause instanceof DriverError
          ? cause
          : new DriverError('PGCLEAR_COPY_SOURCE', 'COPY source failed.', 'unknown', { cause });
    }
  }
  stop(): Promise<void> {
    if (this.#cleanup) return this.#cleanup;
    const ended = this.#state === 'ended';
    this.#state = 'stopped';
    this.#cleanup = Promise.resolve().then(async () => {
      if (ended) return;
      if (this.source instanceof Readable) this.source.destroy();
      await this.#iterator?.return?.();
    });
    void this.#cleanup.catch(() => {});
    return this.#cleanup;
  }
}
