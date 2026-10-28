import { DriverError } from '../errors.js';
import type { OperationOptions } from '../types.js';

/** Absolute monotonic deadlines avoid timer overflow and resetting the budget at each stage. */
export function deadline(delay: number, expire: () => void): () => void {
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
  };
  timer = setTimeout(arm, Math.min(delay, 0x7fffffff));
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
  const abort = () => fail(new DriverError('PGCLEAR_ABORTED', 'Operation aborted.'));
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
