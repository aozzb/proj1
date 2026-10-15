## CHECKPOINT 1

- **Built:** Docker Compose environment with PostgreSQL 17 and Redis 7, including health checks and persistent PostgreSQL storage.
- **Problem encountered:** Host port 5432 was occupied by an existing Windows PostgreSQL process; mapped Docker PostgreSQL to host port 5433.
- **Learned:** Container ports differ from host ports; named volumes preserve PostgreSQL data across container restarts; container health checks verify service readiness.
- **Verified:** Both containers healthy, Redis `PING` returned `PONG`, PostgreSQL query succeeded, and a test record survived a container restart.
- **Interview question:** What happens to database data when a container is restarted or removed, and how do named volumes help?

## CHECKPOINT 1 — Foundations

- **Built:** The full application foundation. TypeScript/Node/Express app
  scaffold (tsconfig, eslint flat config, prettier); a multi-stage `Dockerfile`
  (`dev` runs `tsx watch`, `prod` runs compiled `dist` as non-root); the `api`
  service wired into Compose with hot-reload mounts and `depends_on`
  healthchecks; a `migrate` one-off Compose service. zod-validated, fail-fast env
  config; a shared pino logger with a redaction list; shared `pg` Pool and
  ioredis clients; `GET /health` that probes Postgres and Redis in parallel;
  graceful SIGTERM/SIGINT shutdown. node-pg-migrate wired with a raw-SQL initial
  migration creating all five tables (applications, endpoints, events,
  deliveries, delivery_attempts) plus the key constraints and indexes.
- **Key schema decisions:** UNIQUE(event_id, endpoint_id) on deliveries;
  nullable-UNIQUE idempotency_key on events; partial index on deliveries for the
  worker's "due now" query; UUID ids for exposed rows, bigserial for the
  attempt log; text+CHECK status fields. (Details in docs/decisions.md.)
- **Problem encountered:** eslint's flat config flagged its own `require()`;
  excluded the config file from linting. Left-over `checkpoint_test` table from
  the CP0 restart test was dropped.
- **Verified:** `docker compose up` → all three containers healthy; `/health`
  returns 200 with both checks green; migration applied and is idempotent on
  re-run; all five tables + constraints/indexes present in psql; `tsc --noEmit`
  and `eslint` both clean.
- **Interview questions:** (1) Why UNIQUE(event_id, endpoint_id) rather than
  relying on application code to avoid duplicates? (2) Why is a *partial* index
  on next_attempt_at better than a plain one here? (3) Why validate env with zod
  at startup instead of reading process.env where needed?

## CHECKPOINT 2 — Core APIs

- **Built:** The public HTTP API. `POST /applications` (open bootstrap; returns a
  random API key once, stores only its SHA-256 hash), `POST /endpoints` and
  `POST /events` (both behind Bearer-key auth), plus `GET /applications/me`.
  zod body validation via a `validateBody` middleware; `apiKeyAuth` middleware;
  an `asyncHandler` wrapper + centralized error handler. The publish flow inserts
  the event, fans out to subscribed active endpoints, creates deliveries with
  `ON CONFLICT DO NOTHING`, and enqueues a BullMQ job (producer only) per new
  delivery. Idempotent publish: a repeated idempotency_key returns the existing
  event.
- **Files:** src/lib/crypto.ts, src/lib/queue.ts, src/lib/async-handler.ts,
  src/middleware/auth.ts, src/middleware/validate.ts, src/schemas.ts,
  src/routes/{applications,endpoints,events}.ts; wired in src/app.ts; added
  bullmq dep.
- **Problem encountered:** The Postgres volume had been reset during earlier
  verification, so the first live run hit "relation applications does not exist";
  re-running `docker compose run --rm migrate` fixed it. eslint flagged the
  error handler's unused `next`; added an `argsIgnorePattern: '^_'` rule.
- **Verified:** registered an app; good key -> 200, bad key -> 401; created an
  endpoint (secret returned once); bad event body -> 400; publish -> 202 with 1
  delivery; same idempotency_key twice -> same event_id + idempotent_replay;
  event to an unsubscribed type -> 0 deliveries. In Postgres: 3 events, 2 pending
  deliveries, api_key_hash is a 64-char hash (not the raw key). In Redis: 2
  BullMQ jobs waiting (job id = delivery id). tsc + eslint clean.
- **Known gap (deferred to CP4):** delivery row committed before enqueue -> a
  crash between them orphans a delivery. Marked `CP4 GAP` in src/routes/events.ts.
- **Interview questions:** (1) Why SHA-256 for API keys but bcrypt/argon2 for
  user passwords? (2) Walk the "publish" path and name every point a duplicate
  delivery is prevented. (3) Where exactly is the DB-write/enqueue gap and what
  are two ways to close it?
## CHECKPOINT 3 — Worker and delivery

- **Built:** The delivery pipeline. A BullMQ worker process consumes the
  `deliveries` queue and runs a processor that: loads the delivery/event/endpoint
  fresh from Postgres, skips already-terminal deliveries (at-least-once guard),
  HMAC-SHA256 signs `timestamp.body`, POSTs with a hard 8s timeout, records every
  attempt in delivery_attempts, and classifies the result — 2xx -> succeeded,
  permanent 4xx -> failed (no retry), 5xx/429/408/network/timeout -> retry.
  Retries are BullMQ-native (6 attempts, exponential backoff with full jitter,
  cap 5m); exhausted deliveries become `dead`. Graceful SIGTERM/SIGINT shutdown
  drains in-flight jobs. A standalone chaos receiver (random 200/500/hang, HMAC
  verify, deterministic test knobs) plus `worker` and `chaos-receiver` compose
  services.
- **Files:** src/worker/{index,processor,backoff,classify,repository}.ts,
  src/lib/signing.ts, src/chaos-receiver/index.ts; edited src/config/env.ts
  (delivery config), src/lib/queue.ts (attempts+backoff), src/lib/db.ts +
  src/lib/redis.ts (error listeners), docker-compose.yml (worker + chaos),
  package.json (worker/chaos scripts).
- **Problem encountered:** The worker crashed with "terminating connection due to
  administrator command" when Postgres cycled — the pg Pool had no 'error'
  listener, so an idle-connection error crashed the process. Added pool and redis
  error handlers (also protects the API). This is a real resilience fix, not a
  workaround.
- **Verified (all passed):** (1) immediate success + signature `valid` -> status
  succeeded, 1 attempt; (2) fail-twice-then-succeed -> attempts 500,500,200,
  attempts_count=3, backoff visible in logs; (3) permanent 400 -> failed, exactly
  1 attempt, no retry; (4) hanging receiver -> attempt times out at ~8003ms,
  status_code NULL, TimeoutError, delivery stays pending to retry; (5) SIGTERM
  mid-delivery -> worker drained the in-flight job and exited 0 (not SIGKILL).
  tsc + eslint clean. CP1/CP2 unaffected (health + publish still work).
- **Interview questions:** (1) Why must the processor RETURN (not throw) on a
  400 but THROW on a 500? (2) Why full jitter rather than fixed exponential
  backoff? (3) The worker POSTs, gets 200, then crashes before recording success
  — what happens on retry and what makes that safe?

## CHECKPOINT 4 — Reliability

- **Built:** DLQ (deliveries.status='dead') with `GET /deliveries?status=dead`
  and `POST /deliveries/:id/replay`; idempotency scoped to
  UNIQUE(application_id, idempotency_key); SSRF protection (block private/
  loopback/link-local, at creation + per-delivery) with a dev-only
  SSRF_ALLOW_PRIVATE bypass; per-endpoint rate limit + concurrency cap in Redis
  (throttle => reschedule without consuming an attempt); a per-endpoint circuit
  breaker (closed/open/half-open) in Redis; and a dedicated scheduler service
  running a reconciling sweeper that closes the DB-write/enqueue gap.
- **Files:** src/lib/ssrf.ts, src/routes/deliveries.ts,
  src/worker/{limiter,circuit-breaker}.ts, src/scheduler/{index,sweeper}.ts;
  migrations for idempotency scoping and endpoint throttle columns; edits to
  env.ts, events.ts, endpoints.ts, schemas.ts, worker/processor.ts,
  worker/repository.ts, app.ts, docker-compose.yml, package.json.
- **Problems encountered:** (1) tsx-in-container hot reload didn't always pick up
  edits — restart the service before testing. (2) First concurrency test passed
  falsely because createEndpointSchema stripped rate_limit_per_sec/max_concurrency
  and the INSERT never stored them; fixed schema + insert so per-endpoint
  throttles persist.
- **Verified (all passed):** SSRF blocks localhost/metadata/private/non-http and
  allows public URLs; chaos still works in dev. 100x same key -> 1 event; same
  key across two apps -> 2 events. Always-500 endpoint -> dead/6 (DLQ) -> listed
  -> replay -> succeeded/1. Orphan delivery (inserted with no job) reconciled by
  sweeper -> succeeded. Breaker: closed->open (3 failures)->half-open->closed on
  a fresh successful delivery. Per-endpoint rate=2/sec + concurrency=1 -> all 8
  delivered (spread, none lost). tsc/eslint/build clean. CP1-CP3 unaffected.
- **Interview questions:** (1) Why does a throttled delivery reschedule WITHOUT
  consuming a retry attempt, but an open-circuit skip DOES consume one? (2) Why
  check SSRF again in the worker when we already checked at endpoint creation?
  (3) Why is the reconciling sweeper safe to run every 10s across many pending
  deliveries, and how does it also make Redis recoverable from Postgres?

## CHECKPOINT 5 — Observability and UI

- **Built:** `GET /metrics` (prom-client: default process metrics, an in-process
  `webhook_events_published_total` counter, and Postgres-derived gauges for
  deliveries-by-status, total events, and delivery-attempts-by-result); a
  delivery status API (`GET /deliveries/:id` with full attempt history, plus the
  existing `GET /deliveries?status=` list); and a minimal inline `/dashboard`
  (list, expand attempts, replay button).
- **Files:** src/lib/metrics.ts, src/routes/metrics.ts, src/routes/dashboard.ts;
  added GET /deliveries/:id to src/routes/deliveries.ts; incremented the counter
  in src/routes/events.ts; wired routers in src/app.ts; added prom-client dep.
- **Problem encountered:** After adding prom-client the api container crashed
  with "Cannot find module 'prom-client'" — the anonymous node_modules volume
  was stale from the old image. Fixed by recreating containers (docker compose
  down + up --build); the named Postgres volume preserved the data.
- **Verified (all passed):** /metrics returns real values (deliveries by status,
  attempts by result, events counter, default process metrics); /dashboard
  serves HTML (200); GET /deliveries/:id returns status + all 3 attempts for a
  retried delivery; status filter works; cross-tenant read returns 404.
  tsc/eslint/build clean; CP1-CP4 unaffected.
- **Interview questions:** (1) Why derive delivery metrics from Postgres at
  scrape time instead of incrementing counters in the worker? (2) Why is
  /deliveries/:id scoped by application, and what would break if it weren't?
  (3) Why serve the dashboard as an inline string instead of a static file?

## CHECKPOINT 6 — Quality

- **Built:** Vitest test suite (32 tests) + an automated chaos script + GitHub
  Actions CI. Unit tests: signing (sign/verify/tamper/stale), classify, backoff
  bounds, SSRF ip-classification. Integration tests against real Postgres+Redis:
  publish/auth/zod/idempotency (per-app) via supertest; delivery via a real
  in-process BullMQ worker + controllable receiver covering success+signature,
  retry->success, permanent-4xx (no retry), 5xx->DLQ(dead), hang->timeout, and
  replay->success. Chaos script (scripts/chaos-test.mjs) drives the live compose
  stack for retry/DLQ/replay/100x-idempotency/tamper. CI runs lint->tsc->build->
  vitest with postgres+redis service containers.
- **Files:** vitest.config.ts; tests/{testEnv,globalSetup,setup}.ts,
  tests/helpers/{db,wait,receiver,worker}.ts, tests/unit/*.test.ts,
  tests/integration/*.test.ts; scripts/chaos-test.mjs; .github/workflows/ci.yml;
  package.json (vitest/supertest devDeps + test scripts). No src/ changes —
  CP6 is fully additive.
- **Isolation:** separate webhook_test DB + Redis index /1; globalSetup creates
  and migrates the test DB; truncate + flushdb between tests; small-clock test
  env so retry/DLQ cycles run in ~1-2s; files serial; connections closed in
  afterAll.
- **Problems encountered:** lint flagged ternary-as-statement in the chaos
  script; refactored to an assert() helper.
- **Verified:** `npm test` -> 32/32 passed (6 files). `npm run chaos:test` ->
  all scenarios passed against the live stack. build ok; lockfile in sync so
  `npm ci` (CI) will pass; no src modified so CP1-CP5 behavior unchanged.
- **Interview questions:** (1) Why run tests against real Postgres+Redis instead
  of mocking them, and what would a mock hide here? (2) How do the delivery
  tests stay deterministic while running the real BullMQ worker? (3) Why keep the
  chaos script out of the CI lane that must stay green?
