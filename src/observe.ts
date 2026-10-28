/** Observation is synchronous delivery with isolated failures and no application backpressure. */
export function observe<T>(callback: ((value: T) => void) | undefined, value: T): void {
  if (!callback) return;
  const warn = () => process.emitWarning('pgclear observation callback failed.');
  try {
    void Promise.resolve(callback(value)).catch(warn);
  } catch {
    warn();
  }
}
