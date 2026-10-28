import { DriverError } from '../errors.js';
import type { OperationOptions } from '../types.js';

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

export function watchOperation(
  options: OperationOptions,
  fail: (error: DriverError) => void,
  startupTimeout?: number,
): () => void {
  const abort = () => fail(abortError(options.signal!));
  const timeout =
    options.timeoutMs === undefined
      ? startupTimeout
      : Math.min(options.timeoutMs, startupTimeout ?? Infinity);
  const stop =
    timeout === undefined
      ? () => {}
      : deadline(timeout, () =>
          fail(new DriverError('PGCLEAR_TIMEOUT', 'Operation deadline expired.')),
        );
  options.signal?.addEventListener('abort', abort, { once: true });
  return () => {
    stop();
    options.signal?.removeEventListener('abort', abort);
  };
}

export function abortError(signal: AbortSignal): DriverError {
  return signal.reason instanceof DriverError &&
    ['PGCLEAR_TIMEOUT', 'PGCLEAR_ABORTED'].includes(signal.reason.code)
    ? signal.reason
    : new DriverError('PGCLEAR_ABORTED', 'Operation aborted.');
}

/** A whole-operation deadline survives acquisition, callback execution and final protocol cleanup. */
export class Lifetime {
  readonly #controller = new AbortController();
  readonly signal = this.#controller.signal;
  readonly #stop: () => void;
  readonly #end: number | undefined;
  constructor(options: OperationOptions, parent?: Lifetime) {
    const end = Math.min(
      options.timeoutMs === undefined ? Infinity : performance.now() + options.timeoutMs,
      parent ? (parent.#end ?? Infinity) : Infinity,
    );
    this.#end = end === Infinity ? undefined : end;
    const signal =
      parent && options.signal
        ? AbortSignal.any([parent.signal, options.signal])
        : (parent?.signal ?? options.signal);
    const watched = { ...options, ...(signal ? { signal } : {}) };
    this.#stop = watchOperation(watched, (error) => this.#controller.abort(error));
    if (signal?.aborted) this.#controller.abort(abortError(signal));
    else if (options.timeoutMs === 0)
      this.#controller.abort(new DriverError('PGCLEAR_TIMEOUT', 'Operation deadline expired.'));
  }
  stop(): void {
    this.#stop();
  }
  remaining(): number | undefined {
    return this.#end === undefined
      ? undefined
      : Math.max(0, Math.ceil(this.#end - performance.now()));
  }
  check(): void {
    if (this.remaining() === 0 && !this.signal.aborted)
      this.#controller.abort(new DriverError('PGCLEAR_TIMEOUT', 'Operation deadline expired.'));
    if (this.signal.aborted) throw abortError(this.signal);
  }
}
