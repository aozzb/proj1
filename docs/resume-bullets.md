# Resume bullets (draft — you edit)

**Read before using.** Every number here is measured (see
[BENCHMARKS.md](./BENCHMARKS.md) / [EXPERIMENTS.md](./EXPERIMENTS.md)) but on a
**single developer laptop with an in-container localhost receiver** — a dev-box
ceiling, not a production figure. If you quote a number externally, either keep
the "on a dev laptop, localhost" framing or re-measure on representative
hardware against a real network first. Don't round these up.

## Draft bullets

- Built a production-style **webhook delivery service** (TypeScript, Node,
  Express, PostgreSQL, Redis, BullMQ, Docker Compose) with **at-least-once
  delivery**, HMAC-SHA256 request signing with replay protection, exponential
  backoff with full jitter, a per-endpoint **circuit breaker**, a **dead-letter
  queue with replay**, per-tenant idempotency keys, and SSRF protection.

- Made **Postgres the source of truth** and treated Redis as disposable: a
  reconciling sweeper rebuilds the queue from Postgres, so simulated **Redis data
  loss (`FLUSHALL`) recovered all pending deliveries automatically** (~1.3 s in a
  dev-box experiment).

- Validated resilience with an **automated failure-experiment suite**: killing a
  worker mid-delivery lost nothing (reclaimed in ~31 s), a persistently failing
  endpoint exhausted retries into the DLQ and was recovered by replay, a hanging
  receiver was cut off by an 8 s timeout, 100 duplicate publishes collapsed to one
  event, and tampered payloads were rejected (HTTP 401).

- Measured on a 6-core laptop (localhost, in-container receiver): **~309
  publish requests/sec** at p99 ≈ 153 ms with zero errors, and **300 webhooks
  delivered end-to-end in ~3 s**. (Dev-box numbers; re-measure for production.)

- Shipped a **quality gate**: 32 automated tests (unit + integration) run against
  real Postgres and Redis, plus a GitHub Actions CI pipeline (lint, typecheck,
  build, test) and a scripted chaos test — covering retry, DLQ, idempotency, and
  signature verification.

- Added **observability**: Prometheus `/metrics`, a per-delivery status API, and a
  minimal dashboard with a replay button.

## Honesty reminders (from the project rules)

- State hardware, tool, concurrency and duration whenever you cite a number.
- Say the receiver was localhost / mocked.
- Prefer before/after comparisons; don't invent or estimate.
