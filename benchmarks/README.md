# Benchmarks

[Documentation](../docs/README.md) · [Development](../docs/development.md)

The runner compares packed pgclear with pinned pg 8.23.1 and Postgres.js 3.4.9. Comparator
dependencies stay outside the driver. Results are local exploratory measurements, not production
capacity estimates or universal driver rankings.

## Reproduce a run

Use Node 24+, npm, tar, and `PGCLEAR_TEST_DATABASE_URL` in the root `.env` or environment. The database
must be a TCP `_test` database with TLS disabled and no URL options except `sslmode=disable`.
The runner creates no tables or persistent database objects. Run without concurrent tests or load.

```sh
npm ci
npm ci --prefix benchmarks --ignore-scripts --no-audit --no-fund
npm run benchmark
# Short correctness/adapter check:
npm run benchmark -- --iterations 30 --samples 1 --latencies 0,10
```

Run these commands from the repository root. The runner builds and packs the current working tree,
then measures that archive. It does not download pgclear from npm.

| Option             | Default | Meaning                                                 |
| ------------------ | ------- | ------------------------------------------------------- |
| `--iterations N`   | `1000`  | Base operation count per worker                         |
| `--samples N`      | `3`     | Repetitions of each driver/workload/latency combination |
| `--latencies 0,10` | `0,10`  | Added round-trip delay in milliseconds                  |

Large-result workers use `max(10, ceil(N / 20))` queries; transaction workers use
`max(10, ceil(N / 10))`. At the default iteration count these are 50 and 100. Other workloads use
N operations. Driver order rotates across samples. Each worker has a 180-second limit. Build,
connection setup, discovery, preparation, warmup, and cleanup are outside the measured interval.

Output goes to ignored `.benchmark-dist/run-*`; `.benchmark-dist/latest.json` points to the latest
attempt. Reports retain raw latencies, configuration, versions, Git revision/dirty flag, artifact
hashes, machine and Node/PostgreSQL versions. Failed attempts remain marked failed. Database
credentials are passed through the worker environment and omitted from results.

## What is measured

| Name             | Operation                                            |
| ---------------- | ---------------------------------------------------- |
| `small`          | Sequential unnamed parameterized integer SELECT      |
| `prepared`       | The same SELECT with a warmed prepared statement     |
| `large`          | 1,000 integer object rows per query                  |
| `arrays-json`    | Native int4-array and JSON round trip                |
| `transaction`    | Transaction callback with one SELECT; pool size four |
| `pool`           | Sixteen callers sharing four connections             |
| `pipeline-probe` | Thirty-two callers on one warmed prepared connection |

The six baseline workloads use object rows, matching native values and one active operation per
connection. Each operation checks its returned values. pgclear uses `queryClassic` and its native
parameter/session APIs; pg uses extended queries and acquired transaction clients; Postgres.js uses
extended unsafe queries and begin/reserve APIs. API-specific round trips are part of the measurement.
Postgres.js discovery finishes before timing. Its pool baseline reserves sessions explicitly because
`max_pipeline: 1` alone does not prevent a second operation being sent.

The pipeline probe deliberately enables comparator pipelining while pgclear remains sequential.
It compares different schedulers and must not be used as a baseline ranking. Pipelining can reduce
round-trip waits for independent requests available ahead of time; it does not make one PostgreSQL
backend execute queries simultaneously. pgclear does not implement it.

## Reading metrics

A common bounded TCP relay adds half the requested RTT in each direction and applies backpressure.
Even 0 ms includes relay overhead. It does not emulate bandwidth limits, packet loss, TLS or a real
remote server. Timer scheduling adds noise.

Throughput counts completed operations: a large operation returns 1,000 rows, and a transaction
includes BEGIN/SELECT/COMMIT. Latencies include client queueing and correctness assertions. Per-run
percentiles use nearest rank; summaries take medians across repetitions, not pooled distributions.
Three short samples do not establish precise tails or attribute small performance changes.

CPU is the worker process's user/system delta, excluding PostgreSQL and relay CPU. RSS includes the
runtime baseline and is sampled every 10 ms, so peaks can be missed. It is not an allocation profile.
Use longer repetitions and representative application workloads before drawing performance claims.
Harness checks run with the unit tests; benchmarks themselves are opt-in and outside CI timing gates.

## Recorded results

The decoder-optimization run used Node 24.4.1 and PostgreSQL 16.15, with 1,000 configured iterations,
three samples and both 0/10 ms added-RTT profiles. Its parent revision is b7ecc2a with local decoder
changes (`workingTreeDirty: true`); the recorded archive hash identifies the measured package:

```sh
npm run benchmark -- --iterations 1000 --samples 3 --latencies 0,10
```

Median operations/second at 0 ms added RTT:

| Baseline workload | pgclear |    pg | Postgres.js |
| ----------------- | ------: | ----: | ----------: |
| Small             |   2,855 | 2,858 |       1,653 |
| Prepared          |   2,994 | 3,132 |       3,135 |
| 1,000-row result  |     736 |   869 |         902 |
| Arrays/JSON       |   2,562 | 2,613 |       1,615 |
| Transaction       |     829 | 1,009 |         787 |
| Pool              |   6,756 | 9,253 |       4,935 |

Median operations/second at 10 ms added RTT:

| Baseline workload | pgclear |  pg | Postgres.js |
| ----------------- | ------: | --: | ----------: |
| Small             |      90 |  90 |          45 |
| Prepared          |      91 |  91 |          91 |
| 1,000-row result  |      85 |  86 |          86 |
| Arrays/JSON       |      89 |  90 |          46 |
| Transaction       |      30 |  30 |          23 |
| Pool              |     336 | 338 |         175 |

Round-trip waits dominate the 10 ms profile, bringing pgclear and pg much closer. API-specific
round trips remain part of the measurement, including the comparator reservation/transaction APIs.

[Full measurements](results/decoding-2026-10-29.csv) and
[configuration/summaries](results/decoding-2026-10-29.json) include both latency profiles, the separate
pipeline diagnostic, latencies, CPU and RSS.

The measured optimization selects column decoders once and fills rows directly, reducing repeated
codec lookup and temporary allocations. It preserves validation, custom codecs, and special column
names. Pool scheduling and pipelining are unchanged. See [architecture](../docs/architecture.md)
for the current decoding path.

An [alternating before/after comparison](results/decoding-paired-2026-10-29.json) used the clean parent
package and the same optimized archive as the matrix, with five samples, 10,000 configured
iterations, 100 warmup operations and 0 ms added RTT. Driver settings and correctness checks matched
the matrix. Before/after order reversed on alternate samples; no other tests or benchmarks ran
concurrently. Each large-result sample ran 500 queries, returning 500,000 rows.

| Workload         | Before ops/s | After ops/s | Change | Before client CPU ms | After client CPU ms |
| ---------------- | -----------: | ----------: | -----: | -------------------: | ------------------: |
| Small            |        2,913 |       3,104 |  +6.6% |                1,507 |               1,442 |
| 1,000-row result |          721 |         835 | +15.8% |                  635 |                 547 |
| Pool             |       10,633 |      10,439 |  -1.8% |                1,136 |               1,168 |

Values are medians of five samples; client CPU includes both user and system time for the measured
operations. The large-result improvement accompanies 13.9% less client CPU. The pooled ranges overlap,
so the small pooled decrease does not establish a regression or benefit. These local runs support a
decoding improvement, not a universal throughput claim. The longer comparison and short matrix have
different operation/warmup counts; compare before/after within the comparison rather than mixing
their absolute rates. [Per-sample measurements](results/decoding-paired-2026-10-29.csv) retain latency,
CPU and RSS evidence, and the JSON records both archive hashes.

### Earlier checkpoints

Earlier evidence remains available for reproduction and comparison:

- [Pre-optimization adoption matrix](results/adoption-2026-10-29.json) and
  [measurements](results/adoption-2026-10-29.csv).
- [Initial matrix](results/local-2026-10-28.json) and [measurements](results/local-2026-10-28.csv).
- [Profiled matrix](results/profiled-2026-10-28.json) and [measurements](results/profiled-2026-10-28.csv).
- [Alternating old/new comparison](results/paired-2026-10-28.json) and [measurements](results/paired-2026-10-28.csv).
- [CPU profile summaries and hashes](results/profiles-2026-10-28.json).

These checkpoints use different revisions/configurations. Compare their recorded settings rather
than treating the sequence as a continuous performance trend. Full raw artifacts remain in ignored
benchmark directories in the producing checkout.
