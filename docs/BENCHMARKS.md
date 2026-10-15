# Benchmarks

**Honesty note.** Every number below is measured, not estimated. All runs were on
one developer laptop with the whole stack (API, worker, scheduler, Postgres,
Redis, receiver) on that same machine, and the webhook **receiver is an
in-container server on localhost — not a real network**. These are dev-box
ceilings for comparing configurations, not production figures. Runs are small and
single-shot, so treat them as indicative, not statistically rigorous. Raw output
is in [`docs/benchmarks/`](./benchmarks/).

## Environment (same for all runs)

| | |
|---|---|
| CPU | AMD Ryzen 5 7530U (6 logical cores) |
| RAM | 15.3 GB |
| OS | Windows 10.0.26200 |
| Node | v22.16.0 |
| Docker | 29.8.1 |
| Tool | autocannon 8.0.0 |
| Topology | all services + receiver on one host (Docker Desktop), localhost |

## 1. Publish throughput — `POST /events`

Measures the API accept path: auth → insert event → fan-out → enqueue. 20
connections, 10s. Raw: `docs/benchmarks/publish-*.json`.

| Metric | Value |
|---|---|
| Requests/sec (mean) | **308.8** (stddev 34.2) |
| Latency p50 | 59 ms |
| Latency p97.5 | 117 ms |
| Latency p99 | 153 ms |
| Latency max | 221 ms |
| Responses | 3088 × 2xx, 0 non-2xx |

## 2. End-to-end delivery throughput

Publish 300 events to a forced-200 in-container receiver (**signature
verification off at the receiver** for raw throughput), then time until all 300
reach `succeeded` (measured via the `/metrics` succeeded gauge). `deliveriesPerSec`
is 300 ÷ total wall time (publish + drain), so it is an end-to-end figure, not a
pure worker rate. Raw: `docs/benchmarks/delivery-wc*.json`.

| Worker concurrency | Publish time | Total wall time | Drain-after-publish | End-to-end deliveries/sec |
|---|---|---|---|---|
| 5  | 1356 ms (221/s) | 3150 ms | 1794 ms | **95** |
| 20 | 1208 ms (248/s) | 3810 ms | 2602 ms | **79** |

**Observation (reported as measured, not spun):** raising worker concurrency from
5 to 20 did **not** improve end-to-end throughput here — it was slightly slower.
On a 6-core box with a Postgres pool capped at 10 connections and several DB +
Redis round-trips per delivery (load context, record attempt, mark status,
limiter, breaker), more concurrent workers contend rather than help. These are
single 300-message runs with high variance, so the honest takeaway is only "more
workers did not help at this scale on this hardware," not a scaling law.

## Reproduce

```bash
docker compose down -v && docker compose up -d --build && docker compose run --rm migrate
npm run bench:publish
MESSAGES=300 WORKER_CONCURRENCY=5  docker compose up -d worker && MESSAGES=300 WORKER_CONCURRENCY=5  npm run bench:delivery
MESSAGES=300 WORKER_CONCURRENCY=20 docker compose up -d worker && MESSAGES=300 WORKER_CONCURRENCY=20 npm run bench:delivery
```
