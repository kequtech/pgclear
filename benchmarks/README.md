# Driver benchmarks

M7a measures the packed pgclear driver against pinned `pg` 8.23.1 and Postgres.js 3.4.9. Comparator
dependencies live here, outside the driver's runtime dependencies. These are local exploratory
measurements, not release gates or universal rankings.

## Reproduce

Use Node 24+, the root npm dependencies, `tar`, and the existing `PGCLEAR_TEST_DATABASE_URL` in
`.env`. The runner accepts only a TCP database whose name ends in `_test`, with TLS disabled and
no URL options other than `sslmode=disable`. It creates no tables or persistent database objects.

```sh
npm ci --prefix benchmarks --ignore-scripts --no-audit --no-fund
npm run benchmark
# Quick adapter/correctness smoke test:
npm run benchmark -- --iterations 30 --samples 1 --latencies 0,10
```

Defaults: 1,000 operations, three repetitions and 0/10 ms added round-trip delay. Large results use
50 operations and transactions use 100; `--iterations` scales these counts. Workload order is fixed;
driver order rotates each repetition. Run on a quiet machine without concurrent tests or consumers.
Each worker has a 180-second limit; reduce operation counts when testing larger RTTs.
The runner builds and packs pgclear once, verifies the test database, and starts a fresh Node process
for each driver/workload/repetition/profile. Connection establishment, type discovery, preparation,
warmup and cleanup occur outside the measured interval.

Output goes to ignored `.benchmark-dist/run-*`; `.benchmark-dist/latest.json` points to the last
finished attempt. Individual JSON files retain every measured latency. `report.json` contains all
per-repetition metrics, cross-repetition summaries, exact comparator versions/lock hash, packed-driver
hash, Git revision/dirty flag, machine, Node and PostgreSQL versions. Credentials are passed only in
the worker environment and are not written to results. Failed attempts remain marked as failed.

## Workloads and equivalence

| Workload         | Operation and admission                                                             |
| ---------------- | ----------------------------------------------------------------------------------- |
| `small`          | Sequential unnamed extended-protocol `SELECT $1::integer`                           |
| `prepared`       | Same SELECT with a warmed explicitly named/prepared statement                       |
| `large`          | 1,000 integer object rows per sequential query                                      |
| `arrays-json`    | Round-trip an int4 array and JSON object using native binding helpers               |
| `transaction`    | Sequential public transaction callback containing one SELECT; pool limit four       |
| `pool`           | Sixteen concurrent callers, four connections, one operation per acquired connection |
| `pipeline-probe` | One connection, warmed prepared SELECT, 32 callers; comparator pipelines enabled    |

The six baseline workloads use object rows with matching native integer, array and JSON results and
one active operation per connection. Each operation asserts the returned values, including array
and JSON contents. pgclear uses `queryClassic`, `param`/`json`, explicit `prepare`, and its pool and
transaction APIs. pg uses extended queries, named statements, and explicit BEGIN/COMMIT on an
acquired client. Postgres.js uses `unsafe` with extended protocol, preparation enabled only in the
prepared/probe workloads, and `begin` for transactions. Each driver's public API can incur different
control/description round trips; this measures those APIs rather than rewriting their internals.

Postgres.js's `max_pipeline: 1` alone does not prevent a second queued operation from being sent;
its queue count excludes the active query. Setting zero also prevents its transaction reservation
callback. The baseline pool case therefore uses its public `reserve`/`release`; other baseline
cases submit sequentially. Array type discovery completes before creating typed array parameters.
The fixture does not patch either comparator.

The separate pipeline probe enables `pipeline: true` in pg and `max_pipeline: 32` in Postgres.js.
pgclear retains its sequential scheduler. This diagnostic intentionally compares different
schedulers to estimate potential pipeline benefit; it is not a baseline performance ranking.

## Metrics and limits

Each profile uses the same bounded TCP relay. Added RTT means half the configured delay in each
direction, scheduled from chunk arrival, with backpressure and a 1 MiB pause threshold per direction.
It preserves ordered bytes and half-close behavior; it does not emulate bandwidth limits, packet
loss, TLS, or a real remote server. The 0 ms profile still includes relay overhead. Timer scheduling
and the underlying local network add noise, so 10 ms is not a claim of exact total network latency.

Throughput is completed operations/second; a transaction is one operation containing three
statements, and a large query contains 1,000 rows. Latency includes client queueing and common
correctness assertions. p50/p95/p99 use nearest-rank percentiles of raw samples; summary medians are
medians across repetitions, not pooled request distributions. With only three repetitions and 50
large-result operations, tails are descriptive, not precise statistical estimates.

Client CPU is the measured process's user+system delta. It excludes relay/PostgreSQL CPU and process
startup. RSS/heap start/end and RSS sampled every 10 ms are retained; sampled peak RSS can miss brief
peaks and includes the worker/runtime baseline. These are not allocation profiles. Performance
changes need longer runs, repetitions across environments and a representative consumer workload.

The benchmark harness's numeric-percentile and byte-preserving relay checks run in `npm run check`.
Benchmark execution itself is opt-in and stays outside CI timing gates.

## What pipelining buys

Sequential execution sends one query and waits for its response before sending the next. Pipelining
sends several queries ahead on the same connection, then associates the ordered responses with their
callers. PostgreSQL still executes them in order; a pool instead uses several server connections.
Pipelining is useful for many small operations over a higher-latency network when the client can
construct subsequent requests without reading earlier results. Long server computations and
client-dependent query chains gain less. Prefer set-based SQL or COPY where they fit the operation.
See [PostgreSQL's pipeline documentation](https://www.postgresql.org/docs/18/libpq-pipeline-mode.html).

It also expands the driver's recovery responsibilities: several requests may already be sent when
an error, cancellation or shutdown occurs. Correct result ownership, sent-queue limits and explicit
transaction boundaries must survive those cases. M7b would start with bounded ordinary queries on
exclusive sessions; streaming, COPY and managed transaction semantics would retain their existing
ownership rules. The probe estimates the opportunity without introducing those runtime changes.

## Profiling

The follow-up used Node's native `--cpu-prof --cpu-prof-interval=500` against the existing worker,
with 100,000 configured iterations, 100 warmup operations and the same 0 ms relay. This means 5,000
large queries (five million rows) or 100,000 pool operations. CPU profiles include startup, warmup
and cleanup, so their timing is diagnostic rather than a replacement for uninstrumented benchmarks.
Raw profiles and worker metrics remain in ignored `.benchmark-dist/profiles-before/` and
`.benchmark-dist/profiles-after/` in the producing checkout.

Before changes, row mapping accounts for about 33% of sampled active time inclusively, and expiry
error construction alone accounts for about 14% in the pool profile. Numeric readers also allocate
short-lived Buffer views; ordinary packet handling creates a promise/microtask for each row.
The follow-up uses one-pass own-property row construction, bounded direct numeric reads,
synchronous ordinary packets, lazy scope expiry signals/errors, unconstrained lifetimes without
abort composition, and an immediate return from empty cleanup drains. Authentication, recovery,
stream/COPY backpressure, strict UTF8 and copied payload ownership retain their existing rules.
No generated row functions, decoder cache, alternative pool scheduler or runtime dependency is added.

For a direct CPU exploration without the relay, build once, then profile either worker workload:

```sh
npm run build
mkdir -p .benchmark-dist/profiles
node --env-file-if-exists=.env --cpu-prof --cpu-prof-interval=500 \
  --cpu-prof-dir=.benchmark-dist/profiles --input-type=module - pool <<'JS'
import { resolve } from 'node:path';
process.env.PGCLEAR_BENCH_DATABASE_URL = process.env.PGCLEAR_TEST_DATABASE_URL;
process.env.PGCLEAR_BENCH_PACKAGE = resolve('dist/index.js');
process.argv[2] = JSON.stringify({
  driver: 'pgclear', workload: process.argv[2], iterations: 100000, warmup: 100,
  poolSize: 4, concurrency: 16, batchSize: 32, sample: 0, addedRttMs: 0,
  output: '.benchmark-dist/profiles/worker.json'
});
await import('./benchmarks/worker.mjs');
JS
```

Replace `pool` with `large` for result decoding. Load the generated `.cpuprofile` in a V8-compatible
CPU profile viewer. Keep uninstrumented benchmark runs separate and compare the same configuration.

## Recorded results

The 2026-10-28 run passed all **126 measurements**: seven workloads, three drivers, three
repetitions, two added-RTT profiles. Node 24.4.1 and PostgreSQL 16.15 ran on Linux/WSL2 with an AMD
Threadripper 3970X. Runtime driver sources match M6 `0d31732`; the working tree contains this new
harness, consumer fixture and documentation. The packed artifact hash identifies the measured build.

Checked-in evidence: [per-repetition metrics](results/local-2026-10-28.csv) and
[configuration/provenance](results/local-2026-10-28.json). Complete per-request latency arrays and
the original report remain in `.benchmark-dist/run-o9qK8H/` in the producing checkout.

Median completed operations/second across the three repetitions:

| Baseline workload  | Added RTT | pgclear |    pg | Postgres.js |
| ------------------ | --------- | ------: | ----: | ----------: |
| Small unnamed      | 0 ms      |   2,612 | 2,873 |       1,610 |
| Prepared           | 0 ms      |   2,605 | 2,689 |       2,695 |
| Large (1,000 rows) | 0 ms      |     506 |   979 |         876 |
| Arrays/JSON        | 0 ms      |   2,346 | 2,621 |       1,530 |
| Transaction        | 0 ms      |     753 |   998 |         790 |
| Pool contention    | 0 ms      |   4,366 | 9,232 |       5,072 |
| Small unnamed      | 10 ms     |      89 |    89 |          45 |
| Prepared           | 10 ms     |      89 |    90 |          91 |
| Large (1,000 rows) | 10 ms     |      79 |    83 |          83 |
| Arrays/JSON        | 10 ms     |      87 |    90 |          45 |
| Transaction        | 10 ms     |      30 |    30 |          23 |
| Pool contention    | 10 ms     |     334 |   336 |         172 |

pgclear is close on local prepared single-row queries, but trails pg on large results and pool
contention. Median client CPU per 1,000-row operation is approximately 2.27 ms versus pg's 1.19 ms;
pool-operation CPU is 0.322 ms versus 0.142 ms. These observations justify profiling the result and
pool paths; they do not locate the cause. In those local workloads, pgclear's median p95 latency is
2.59/6.10 ms versus pg's 1.99/2.83 ms. Sampled peak RSS is 74.7/83.7 MiB versus 73.5/72.5 MiB;
RSS includes the entire worker/runtime baseline. All repetitions and tail/memory metrics are in the CSV.

With 10 ms added RTT, pgclear and pg converge on roughly 89 sequential small queries/second. The
pinned Postgres.js unnamed API performs a description round trip before binding parameterized
queries, explaining its different network ceiling here; warmed preparation brings all three close.

The separate **pipeline diagnostic**, with 32 callers on one prepared connection, gives:

| Added RTT | pgclear sequential | pg pipeline enabled | Postgres.js pipeline enabled |
| --------- | -----------------: | ------------------: | ---------------------------: |
| 0 ms      |              2,930 |              20,561 |                       31,585 |
| 10 ms     |                 90 |               2,594 |                        1,998 |

At 10 ms the median p95 latency is 360.30 ms for queued sequential pgclear, 13.08 ms for pg's
pipeline and 22.82 ms for Postgres.js's pipeline. This demonstrates an opportunity for requests
available ahead of time; it does not predict pgclear's eventual pipeline throughput. Existing code
that awaits each response before submitting another query would still be sequential.

The next investigation should profile local large-result and pool overhead and assess an actual
consumer's available concurrency/RTT. M7b remains optional; full Tenon adoption and the M8 release
checks remain separate correctness work. No benchmark result justifies weakening ownership rules.
