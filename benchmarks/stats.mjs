export function summarize(samples) {
  if (!samples.length || samples.some((value) => !Number.isFinite(value) || value < 0))
    throw Error('Measurements must contain finite nonnegative samples.');
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (p) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
  return {
    min: sorted[0],
    median: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: sorted.at(-1),
  };
}
