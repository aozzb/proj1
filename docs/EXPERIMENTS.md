# Failure experiments

Each experiment runs against the live stack via `npm run experiments` and writes
a raw, timestamped log to [`docs/experiments/`](./experiments/). Timings below are
from one real run on the dev box described in [BENCHMARKS.md](./BENCHMARKS.md)
(localhost, in-container receiver); exact numbers vary per run.

| # | Experiment | What it proves | Observed result (one run) | Raw log |
|---|---|---|---|---|
| 1 | **Kill a worker mid-delivery** | At-least-once: a crash loses nothing | Worker killed mid-POST; the new worker reclaimed the stalled job and delivered — recovered after **~31 s** | `worker-kill-mid-delivery.txt` |
| 2a | **Receiver fails then recovers (within budget)** | Transient failures self-heal via retries | Receiver failed 2× then 200; delivered automatically, no operator action | `receiver-transient-failures-auto-recover.txt` |
| 2b | **Receiver 500 persistently, then recovers** | Exhaustion → DLQ, then replay | Reached DLQ (`dead`) after **~21 s**; after the circuit-breaker cooldown, replay delivered in **~0.5 s** | `receiver-500-exhaust-to-dlq-then-replay.txt` |
| 3 | **Receiver hangs** | A hanging receiver can't block a worker | Attempt aborted at the ~8 s timeout (null status, timeout error) and was retried | `receiver-hang-timeout.txt` |
| 4 | **Restart/lose Redis** | Redis state is recoverable from Postgres | 20 queued deliveries; `FLUSHALL` wiped the queue; the sweeper re-enqueued them from Postgres and delivered all — recovered in **~1.3 s** | `redis-loss-recovery.txt` |
| 5 | **Publish same event 100× with one key** | Idempotency prevents duplicates | 100 publishes collapsed to exactly one event | `idempotency-100x.txt` |
| 6 | **Tampered body** | HMAC verification rejects tampering | Valid signature → 200; tampered body (same signature) → 401 | `tamper-rejected.txt` |

## Honest notes on the design interplay these surfaced

- **The "500 for 10 minutes" scenario, truthfully:** with the default schedule
  (6 attempts, exponential backoff capped at 5 min) a persistently-failing
  endpoint reaches the DLQ in a few minutes, **not** 10. So the real recovery
  story for a long outage is **DLQ + replay** (experiment 2b), not silent
  auto-healing after 10 minutes. Experiment 2a shows the separate case where a
  *short* outage is absorbed by retries alone.
- **Circuit breaker vs. replay:** sustained 500s also trip the per-endpoint
  circuit breaker open. Replaying while it is open just fast-fails until the
  cooldown elapses, so experiment 2b explicitly waits out the ~30 s cooldown
  before replaying. That is the real behaviour, documented rather than hidden.
- **Worker-kill recovery latency:** recovery relies on BullMQ's stalled-job
  reclaim (~30 s interval), so a mid-flight crash recovers in tens of seconds,
  not instantly. Nothing is lost; it is just not immediate.

## Reproduce

```bash
docker compose up -d && node scripts/experiments/run.mjs
```
