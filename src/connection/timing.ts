import { DriverError } from '../errors.js';
import type { OperationOptions } from '../types.js';

/** Fixed cleanup budget for physical resources; operation deadlines remain caller controlled. */
export const CLEANUP_TIMEOUT_MS = 5000;

/** Absolute monotonic deadlines avoid timer overflow and resetting the budget at each stage. */
export function deadline(delay: number, expire: () => void, unref = false): () => void {
  const end = performance.now() + delay;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const arm = () => {
    if (stopped) return;
    const remaining = end - performance.now();
    if (remaining <= 0) {
      expire();
      return;
    }
    timer = setTimeout(arm, Math.min(remaining, 0x7fffffff));
    if (unref) timer.unref();
  };
  timer = setTimeout(arm, Math.min(delay, 0x7fffffff));
  if (unref) timer.unref();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

export function abortError(signal: AbortSignal): DriverError {
  return signal.reason instanceof DriverError &&
    ['PGCLEAR_TIMEOUT', 'PGCLEAR_ABORTED'].includes(signal.reason.code)
    ? signal.reason
    : new DriverError('PGCLEAR_ABORTED', 'Operation aborted.');
}

/** Internal execution context. Public options are validated before constructing it. */
export interface ExecutionOptions {
  readonly lifetime: Lifetime;
  readonly rowMode?: 'object' | 'array';
  readonly batchSize?: number;
}

/** One absolute deadline. Children inherit it and arm a timer only for a shorter local limit. */
export class Lifetime {
  readonly #controller = new AbortController();
  readonly signal: AbortSignal;
  readonly end: number;
  readonly #stop: () => void;
  constructor(options: OperationOptions = {}, parent?: Lifetime, limit = Infinity) {
    const ownEnd = Math.min(
      options.timeoutMs === undefined ? Infinity : performance.now() + options.timeoutMs,
      limit,
    );
    this.end = Math.min(ownEnd, parent?.end ?? Infinity);
    this.signal = AbortSignal.any([
      this.#controller.signal,
      ...(parent ? [parent.signal] : []),
      ...(options.signal ? [options.signal] : []),
    ]);
    const stopTimer =
      ownEnd < (parent?.end ?? Infinity)
        ? deadline(Math.max(0, ownEnd - performance.now()), () =>
            this.#controller.abort(
              new DriverError('PGCLEAR_TIMEOUT', 'Operation deadline expired.'),
            ),
          )
        : () => {};
    this.#stop = stopTimer;
  }
  stop(): void {
    this.#stop();
  }
  check(): void {
    if (this.signal.aborted) throw abortError(this.signal);
    if (performance.now() >= this.end)
      throw new DriverError('PGCLEAR_TIMEOUT', 'Operation deadline expired.');
  }
  watch(fail: (error: DriverError) => void): () => void {
    const abort = () => fail(abortError(this.signal));
    this.signal.addEventListener('abort', abort, { once: true });
    return () => {
      this.signal.removeEventListener('abort', abort);
      this.stop();
    };
  }
}
