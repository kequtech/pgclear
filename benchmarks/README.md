# Benchmarks

[Documentation](../README.md) · [Development](../CONTRIBUTING.md)

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
# Direct local baseline (no relay):
npm run benchmark -- --iterations 10000 --samples 5 --latencies 0 --transport direct
# Short correctness/adapter check:
npm run benchmark -- --iterations 30 --samples 1 --latencies 0,10
```

Run these commands from the repository root. The runner builds and packs the current working tree,
then measures that archive. It does not download pgclear from npm.

| Option             | Default | Meaning                                                  |
| ------------------ | ------- | -------------------------------------------------------- |
| `--iterations N`   | `1000`  | Base operation count per worker                          |
| `--samples N`      | `3`     | Repetitions of each driver/workload/latency combination  |
| `--latencies 0,10` | `0,10`  | Added round-trip delay in milliseconds                   |
| `--transport MODE` | `relay` | `direct` bypasses the relay and requires `--latencies 0` |

`--workloads large,wide,pool` selects a subset; defaults retain the original seven workloads.
The optional wide case returns six mixed-type columns.

Large-result workers use `max(10, ceil(N / 20))` queries; transaction workers use
`max(10, ceil(N / 10))`. At the default iteration count these are 50 and 100. Other workloads use
N operations. Driver order rotates across samples. Each worker has a 180-second limit. Build,
connection setup, discovery, preparation, warmup, and cleanup are outside the measured interval.

Output goes to ignored `.benchmark-dist/run-*`; `.benchmark-dist/latest.json` points to the latest
attempt. Reports retain raw latencies, configuration, versions, Git revision/dirty flag, artifact
hashes, machine and Node/PostgreSQL versions. Failed attempts remain marked failed. Database
credentials are passed through the worker environment and omitted from results.

## What is measured

| Name             | Operation                                                                   |
| ---------------- | --------------------------------------------------------------------------- |
| `small`          | Sequential unnamed parameterized integer SELECT                             |
| `prepared`       | The same SELECT with a warmed prepared statement                            |
| `large`          | 1,000 integer object rows per query                                         |
| `wide` (opt-in)  | 1,000 rows of integer, Unicode text, boolean, float, JSON and array columns |
| `arrays-json`    | Native int4-array and JSON round trip                                       |
| `transaction`    | Transaction callback with one SELECT; pool size four                        |
| `pool`           | Sixteen callers sharing four connections                                    |
| `pipeline-probe` | Thirty-two callers on one warmed prepared connection                        |

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

Direct mode measures the database connection without a proxy. Relay mode adds half the requested
RTT in each direction with bounded buffering/backpressure. Even its 0 ms profile includes relay
costs; it is not a direct connection. The relay does not emulate bandwidth, loss, TLS or a remote
server. Timer scheduling and host load add noise.

Throughput counts completed operations: a large operation returns 1,000 rows, and a transaction
includes BEGIN/SELECT/COMMIT. Latencies include client queueing and correctness assertions. Per-run
percentiles use nearest rank; summaries take medians across repetitions, not pooled distributions.
Three short samples do not establish precise tails or attribute small performance changes.

CPU is the worker process's user/system delta, excluding PostgreSQL and relay CPU. RSS includes the
runtime baseline and is sampled every 10 ms, so peaks can be missed. It is not an allocation profile.
Use longer repetitions and representative application workloads before drawing performance claims.
Harness checks run with the unit tests; benchmarks themselves are opt-in and outside CI timing gates.

## Recorded results — November 2, 2026

Measured pgclear 0.3.6 (runtime revision 17fae30), pg 8.23.1 and Postgres.js 3.4.9, on Node 24.4.1,
PostgreSQL 16.15 and a Ryzen Threadripper 3970X under WSL2. Runs were sequential, without concurrent
tests. All three profiles measured identical packed driver bytes. The direct/delayed runs mark the
tree dirty because of benchmark-tool changes; their archive hash matches the clean-tree relay run.

Direct TCP, median operations/second across five repetitions of 10,000 configured iterations:

| Workload         | pgclear |    pg | Postgres.js |
| ---------------- | ------: | ----: | ----------: |
| Small            |   4,569 | 4,973 |       2,713 |
| Prepared         |   5,832 | 5,162 |       5,794 |
| 1,000-row result |     953 | 1,290 |       1,301 |
| Arrays/JSON      |   3,744 | 4,287 |       2,636 |
| Transaction      |   1,317 | 1,718 |       1,333 |
| Pool             |   7,739 | 9,647 |       6,551 |

Each large-result repetition runs 500 queries; each transaction repetition runs 1,000. Small-query
ranges overlap substantially, so these medians do not establish a stable winner. pgclear trails both
comparators on large results and pg on pooled queries in this run; inspect CPU and latency ranges
before extrapolating to an application.

With 10 ms added RTT, the most useful distinction is round trips and scheduling. The following
short diagnostic uses three repetitions of 300 configured iterations:

| Workload                                  | pgclear |    pg | Postgres.js |
| ----------------------------------------- | ------: | ----: | ----------: |
| Prepared, one caller                      |      86 |    87 |          87 |
| Transaction                               |      29 |    29 |          22 |
| Pool, 16 callers / 4 connections          |     331 |   340 |         170 |
| Pipeline probe, 32 callers / 1 connection |      89 | 2,437 |       1,950 |

Single-caller prepared rates converge around the round-trip limit. The pipeline probe enables
comparator pipelining while pgclear remains sequential: its gap matters for independent requests
queued ahead, but is not a baseline driver ranking. This short profile has only 15 large queries
and 30 transactions per repetition; it does not establish precise latency tails.

The zero-delay relay run is retained separately. For example, pgclear's small-query median was
3,108 ops/s through the relay versus 4,569 directly. Its pool rates also differed. Separate runs,
transport and scheduling effects make these different measurement conditions, not a regression test.

| Evidence         | Settings                         | Files                                                                                                                |
| ---------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Direct local     | 10,000 iterations, 5 repetitions | [Summary/config](results/current-direct-2026-11-02.json), [samples](results/current-direct-2026-11-02.csv)           |
| 10 ms relay      | 300 iterations, 3 repetitions    | [Summary/config](results/current-delayed-2026-11-02.json), [samples](results/current-delayed-2026-11-02.csv)         |
| Zero-delay relay | 10,000 iterations, 5 repetitions | [Summary/config](results/current-relay-local-2026-11-02.json), [samples](results/current-relay-local-2026-11-02.csv) |

Reproduce the delayed diagnostic with
`npm run benchmark -- --iterations 300 --samples 3 --latencies 10`;
for the zero-delay relay, use `--iterations 10000 --samples 5 --latencies 0`.
The files retain archive/source-report hashes, environment, actual operation counts, per-repetition
latencies, client CPU and sampled RSS. Absolute rates are local observations, not capacity guarantees.

### Frame receive optimization for 0.3.7

Profiling pgclear and pg identified frame allocation/copying as a large-result cost. The change lets
complete messages borrow immutable socket chunks; partial frames still use owned buffers. Protocol
limits, UTF8/codec validation and public byte ownership are preserved. The measured candidate was a
local 0.3.6 build; its JavaScript is byte-identical to the 0.3.7 build, with unchanged public declarations.

Five alternating before/after repetitions, 30,000 configured iterations each, direct TCP, with pg
8.23.1 measured in the same sequence. Large/wide repetitions each return 1.5 million rows.
Medians across repetitions:

| Workload              | Before ops/s | After ops/s | Change | Before client CPU ms | After client CPU ms |
| --------------------- | -----------: | ----------: | -----: | -------------------: | ------------------: |
| 1,000 integer rows    |          965 |       1,161 | +20.4% |                1,492 |               1,209 |
| 1,000 mixed-type rows |          238 |         248 |  +4.1% |                6,186 |               5,914 |
| Small                 |        5,650 |       5,178 |  -8.4% |                3,541 |               3,825 |
| Pool                  |        9,264 |       9,416 |  +1.6% |                3,671 |               3,624 |
| Transaction           |        1,587 |       1,532 |  -3.5% |                1,580 |               1,619 |

The integer-row improvement appeared in every pair (+16–22%) with about 19% less client CPU.
Mixed rows improved in four of five pairs, with about 4% less CPU. pg still led the large/mixed cases
at 1,383/353 ops/s; this closes part of the gap. Sampled RSS was similar before/after.

The small/transaction medians above looked worse, but paired differences varied in sign. A follow-up
ran 20 shorter alternating blocks in one warm process: median rates changed +1.7% for small queries
and +0.3% for transactions, with overlapping ranges. Treat these as neutral, and do not claim a pooled
speedup from +1.6%. Separate-process startup/JIT/host variation matters for small differences.

An ASCII conversion shortcut was also screened and rejected: it was slower than the existing strict
TextDecoder in isolated tests. No text-decoding change was retained.

Evidence: [paired settings/summaries](results/framing-paired-2026-11-02.json),
[per-repetition measurements](results/framing-paired-2026-11-02.csv),
[warm interleaved blocks](results/framing-focused-2026-11-02.json),
[profile summaries/hashes](results/framing-profiles-2026-11-02.json), and
[rejected UTF8 screening](results/utf8-screening-2026-11-02.json).

To compare frozen archives without rebuilding either during measurement:

```sh
node --env-file-if-exists=.env benchmarks/compare.mjs --before /path/before.tgz --after /path/after.tgz
# Filter or shorten a diagnostic with --workloads large,wide --iterations 10000 --samples 3.
```

### Earlier checkpoints

Historical experiments remain available; their revisions and settings differ from the current run:

- [October 29 decoder matrix](results/decoding-2026-10-29.json) and [samples](results/decoding-2026-10-29.csv).
- [Alternating decoder comparison](results/decoding-paired-2026-10-29.json) and [samples](results/decoding-paired-2026-10-29.csv).
- [Pre-optimization adoption matrix](results/adoption-2026-10-29.json) and [samples](results/adoption-2026-10-29.csv).
- [October 28 initial matrix](results/local-2026-10-28.json), [profiled matrix](results/profiled-2026-10-28.json),
  [alternating comparison](results/paired-2026-10-28.json) and [CPU profiles](results/profiles-2026-10-28.json).

Do not treat these checkpoints as a continuous performance trend. Raw per-operation traces remain
in the ignored benchmark directories of the producing checkout.
