# Benchmarks

The runner compares packed pgclear with pinned pg 8.23.1 and Postgres.js 3.4.9. Comparator
dependencies stay outside the driver. Results are local exploratory measurements, not production
capacity estimates or universal driver rankings.

## Run

Use Node 24+, root dependencies, tar and `PGCLEAR_TEST_DATABASE_URL` in the root `.env`. The database
must be a TCP `_test` database with TLS disabled and no URL options except `sslmode=disable`.
The runner creates no tables or persistent database objects. Run without concurrent tests or load.

```sh
npm ci --prefix benchmarks --ignore-scripts --no-audit --no-fund
npm run benchmark
# Short correctness/adapter check:
npm run benchmark -- --iterations 30 --samples 1 --latencies 0,10
```

Defaults are 1,000 operations, three samples and 0/10 ms added RTT. Large results use 50 queries;
transactions use 100. `--iterations` scales those counts. Driver order rotates across samples.
Each worker has a 180-second limit. Build, connection setup, discovery, preparation, warmup and
cleanup are outside the measured interval.

Output goes to ignored `.benchmark-dist/run-*`; `.benchmark-dist/latest.json` points to the latest
attempt. Reports retain raw latencies, configuration, versions, Git revision/dirty flag, artifact
hashes, machine and Node/PostgreSQL versions. Failed attempts remain marked failed. Database
credentials are passed through the worker environment and omitted from results.

## Workloads

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
connection. Each operation checks its returned values. pgclear uses queryClassic and its native
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

The latest retained run used clean runtime revision 52a587e, Node 24.4.1 and PostgreSQL 16.15, with
1,000 configured iterations, three samples and only the 0 ms added-RTT profile:

```sh
npm run benchmark -- --iterations 1000 --samples 3 --latencies 0
```

Median operations/second:

| Baseline workload | pgclear |    pg | Postgres.js |
| ----------------- | ------: | ----: | ----------: |
| Small             |   2,860 | 2,911 |       1,637 |
| Prepared          |   3,077 | 3,130 |       3,146 |
| 1,000-row result  |     632 |   939 |         970 |
| Arrays/JSON       |   2,356 | 2,487 |       1,420 |
| Transaction       |     814 |   979 |         776 |
| Pool              |   6,831 | 9,119 |       4,659 |

[Full measurements](results/adoption-2026-10-29.csv) and
[configuration/summaries](results/adoption-2026-10-29.json) include the separate pipeline diagnostic,
latencies, CPU and RSS. Matching prior samples showed no material regression; these short separate
runs do not isolate an optimization benefit.

Earlier evidence remains available for reproduction and comparison:

- [Initial matrix](results/local-2026-10-28.json) and [measurements](results/local-2026-10-28.csv).
- [Profiled matrix](results/profiled-2026-10-28.json) and [measurements](results/profiled-2026-10-28.csv).
- [Alternating old/new comparison](results/paired-2026-10-28.json) and [measurements](results/paired-2026-10-28.csv).
- [CPU profile summaries and hashes](results/profiles-2026-10-28.json).

These checkpoints use different revisions/configurations. Compare their recorded settings rather
than treating the sequence as a continuous performance trend. Full raw artifacts remain in ignored
benchmark directories in the producing checkout.
