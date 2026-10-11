## Checkpoints
CP1: Foundations. Compose (API, Postgres, Redis) running, migrations, schema, health endpoint, config/env handling, structured logging.
Done when: `docker compose up` works and the schema is migrated.

CP2: Core APIs. Register application and endpoint, publish event (with zod validation, API-key auth with hashed keys), event stored in Postgres, delivery job enqueued in BullMQ.
Done when: I can publish an event and see a delivery job in the queue.

CP3: Worker and delivery. Worker POSTs payload to the endpoint with a timeout (5-10s), records every attempt, signs requests with HMAC-SHA256 over timestamp + body, sends an event-id header. Retry with exponential backoff + jitter and configurable max attempts. Only retry 5xx/timeouts/network errors, not permanent 4xx. Includes a chaos receiver (a tiny server that randomly fails or hangs) and graceful SIGTERM shutdown.
Done when: events reach the flaky receiver and eventually succeed.

CP4: Reliability. Dead-letter handling plus a replay endpoint, idempotency keys on publish, per-endpoint rate limiting and concurrency caps, circuit breaker (closed/open/half-open), SSRF protection on endpoint URLs, and a solution for the "DB write succeeded but enqueue failed" gap (outbox pattern or reconciling sweeper).
Done when: permanently failing endpoints land in the DLQ, replay works, duplicates are prevented.

CP5: Observability and UI. /metrics (Prometheus counters), delivery status API, minimal dashboard with a replay button.
Done when: I can see attempts and status per delivery.

CP6: Quality. Integration tests for critical paths, an automated chaos test script, GitHub Actions CI (lint, test, build).
Done when: CI is green and tests cover retry, DLQ, idempotency and signature verification.

CP7: Measure and document. k6/autocannon load tests, failure experiments (kill worker mid-delivery, receiver 500 for 10 minutes, hanging receiver, restart Redis, 100 duplicate publishes with one idempotency key, tampered body), README with architecture diagram and trade-offs, resume bullets from MEASURED numbers only. Keep scripts and raw output in the repo.

Deployment (VPS + Nginx + HTTPS) comes after CP7 and we'll plan it separately.

Out of scope: user signup UI, billing, multi-region, fancy frontend.

## At the end of every checkpoint
1. Summarize what changed and which files
2. Tell me how to verify it works (commands to run)
3. Ask me 3 interview-style questions about what I just built
4. Stop and wait for my go-ahead before the next checkpoint

Start with Step 0 now.