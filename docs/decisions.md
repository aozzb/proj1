# Design decisions

A running log of choices: what we picked, why, and the trade-off.

## CP1 Foundations

### Migration tool: node-pg-migrate (with raw SQL)
- **What:** Use `node-pg-migrate` for schema migrations, writing the schema as
  raw SQL inside migrations rather than through an ORM.
- **Why:** The project goal is to understand and be able to rebuild every core
  piece. Raw SQL keeps the schema fully visible (constraints, indexes, enums)
  instead of hiding it behind generated ORM code.
- **Trade-off:** More typing and no auto-generated typed client (as Prisma would
  give). Acceptable: the schema is interview material, so explicitness wins.

### DB driver: node-postgres (`pg`) with a single shared Pool
- **What:** Query Postgres through one shared `pg.Pool` per process.
- **Why:** Simple, standard, no abstraction between us and SQL. Pooling avoids
  per-request connection overhead.
- **Trade-off:** We write SQL by hand and manage our own query helpers.

### Dev runtime: API in Docker Compose with hot reload
- **What:** The `api` service runs in Compose via the `dev` Dockerfile stage
  (`tsx watch`), with `src/` and `migrations/` mounted and `node_modules` kept
  from the image.
- **Why:** One `docker compose up` runs the whole system and matches prod
  topology (service-name hostnames, same network). Fewer "works on my host"
  surprises.
- **Trade-off:** Slightly slower reloads than running Node on the host, and an
  anonymous volume for `node_modules` that must be rebuilt when deps change.

### Config validated with zod, fail-fast at startup
- **What:** `src/config/env.ts` parses `process.env` with a zod schema and exits
  if anything is missing/malformed.
- **Why:** Turns a class of runtime "undefined" bugs into an immediate, readable
  startup error.
- **Trade-off:** None meaningful.

### Schema: UUID ids for exposed rows, bigserial for the attempt log
- **What:** `applications`, `endpoints`, `events`, `deliveries` use UUID primary
  keys (`gen_random_uuid()`); `delivery_attempts` uses `bigserial`.
- **Why:** Event and delivery ids are exposed to the outside world (the `event-id`
  header, dashboard, logs). UUIDs are non-enumerable — a receiver can't guess
  other customers' ids. `delivery_attempts` is a high-volume, internal,
  append-only log where natural insertion order is useful and the id is never
  exposed, so a cheap monotonic `bigserial` fits.
- **Trade-off:** UUID PKs are wider and not sequential (slightly worse index
  locality). Fine at this scale.

### Status fields: text + CHECK, not native ENUM
- **What:** `endpoints.status` and `deliveries.status` are `text` with a `CHECK`
  constraint listing allowed values.
- **Why:** The delivery state machine will grow (CP3/CP4). Adding a value to a
  `CHECK` is a quick constraint swap; adding to a native `ENUM` type via
  `ALTER TYPE` is more rigid and can't be done inside some transaction contexts.
- **Trade-off:** Slightly less type-level rigor than a native enum. Current
  delivery states are provisional: `pending | succeeded | failed | dead`.

### idempotency_key is UNIQUE but nullable
- **What:** `events.idempotency_key text UNIQUE` (nullable).
- **Why:** Postgres treats NULLs as distinct in a UNIQUE index, so events
  published without a key are never collapsed, while two publishes with the same
  key hit the unique violation and dedupe to one row (CP4 builds on this).
- **Trade-off:** None; this is exactly the behavior we want.

### UNIQUE(event_id, endpoint_id) on deliveries
- **What:** A unique constraint on the (event, endpoint) pair.
- **Why:** The backbone of at-least-once-without-duplicates. At most one delivery
  obligation can exist per pair, so a retried or double-run enqueue can safely do
  `INSERT ... ON CONFLICT DO NOTHING` instead of creating a duplicate delivery.
- **Trade-off:** None meaningful.

### Partial index for the worker's due-deliveries query
- **What:** `deliveries_due_idx ON deliveries (next_attempt_at) WHERE status = 'pending'`.
- **Why:** The worker repeatedly asks "which pending deliveries are due now?"
  A partial index only indexes in-flight rows, so it stays small even as
  succeeded/dead rows accumulate.
- **Trade-off:** The index must be maintained on every status change, but that
  cost is tiny next to the scan it avoids.

### FKs cascade on delete; updated_at via trigger
- **What:** Child rows cascade-delete with their parent; a `set_updated_at`
  trigger maintains `updated_at` on `endpoints` and `deliveries`.
- **Why:** Deleting an application should cleanly remove its endpoints, events,
  deliveries and attempts. A DB trigger guarantees `updated_at` is correct even
  if some future code path forgets to set it.
- **Trade-off:** Cascades can delete a lot at once; acceptable given the model.

## CP2 Core APIs

### API keys: random token, SHA-256 hash stored, shown once
- **What:** `POST /applications` returns a random `whsk_<64 hex>` key once; we
  store only its SHA-256 hash. Auth hashes the presented key and looks it up.
- **Why:** API keys are high-entropy random tokens, so a fast hash is safe
  (nothing to brute-force) and gives an O(1) exact lookup. Slow password hashes
  (bcrypt/argon2) exist to defend low-entropy human passwords — not needed here.
- **Trade-off:** If the DB leaked, raw keys aren't recoverable (good), but we
  also can't show a key again — the client must store it on creation.

### App registration is unauthenticated; everything else needs the key
- **What:** `POST /applications` is open (bootstrap); `/endpoints` and `/events`
  require `Authorization: Bearer <key>`.
- **Why:** Something has to mint the first credential. Keeps CP2 simple.
- **Trade-off:** Open registration would need rate-limiting/an admin key in a
  real deployment. Acceptable for this project's scope.

### Publish = insert event, fan out, create deliveries, enqueue
- **What:** On publish we insert the event, select active endpoints subscribed to
  the type (`event_types @> ARRAY[type]`), `INSERT ... ON CONFLICT DO NOTHING`
  one delivery per endpoint, then enqueue a BullMQ job per new delivery.
- **Why:** The unique (event_id, endpoint_id) constraint makes delivery creation
  naturally idempotent; the job only carries the delivery id (Postgres is the
  source of truth, so the worker reloads fresh rows in CP3).
- **Trade-off / known gap:** The row is committed before the enqueue, so a crash
  between them orphans a delivery (pending, no job). Left as a marked `CP4 GAP`
  in code; CP4 adds an outbox or reconciling sweeper.

### Idempotent publish via a UNIQUE idempotency_key
- **What:** A repeated `idempotency_key` returns the existing event id with
  `idempotent_replay: true` instead of creating a new event. Concurrent
  same-key publishes are resolved by catching the unique-violation (23505).
- **Why:** Lets clients retry a publish safely. Full semantics/tests are CP4.
- **Trade-off:** Minimal CP2 version; no per-application scoping of the key yet
  (the column is globally unique).

### BullMQ job id = delivery id
- **What:** Each job uses `jobId = deliveryId`.
- **Why:** Queue-level dedupe on top of the row constraint — re-enqueuing the
  same delivery collapses to one job.
- **Trade-off:** With `removeOnComplete`, a later re-publish could create a new
  job for a completed delivery; the worker (CP3) guards against re-delivering an
  already-succeeded delivery by checking status.

### Logging: pino with a redaction list from day one
- **What:** One shared pino logger; redaction paths for auth headers, secrets,
  and API keys are configured before any such data exists.
- **Why:** Engineering rule — never log secrets. Setting redaction up front
  makes "don't leak" the default rather than something to remember later.
- **Trade-off:** Must keep the redaction path list in sync with new secret-ish
  fields.

## CP3 Worker and delivery

### Retry engine: BullMQ-native attempts + custom jitter backoff
- **What:** Each delivery job carries `attempts = MAX_ATTEMPTS` and
  `backoff: { type: 'custom' }`; the Worker's `backoffStrategy` returns the
  delay. The processor THROWS only on retryable failures and RETURNS on success
  and on permanent 4xx.
- **Why:** Reuses BullMQ's battle-tested scheduling/locking instead of us
  re-implementing a scheduler. Postgres still holds the truth (status,
  attempts_count, next_attempt_at).
- **Trade-off:** We must be disciplined about the throw/return contract — a stray
  throw on a 4xx would waste all attempts; a swallowed error on a 5xx would skip
  retries. The rule lives in one place (the processor).

### Retry schedule (documented)
- **What:** 6 attempts; exponential `min(cap, base * 2^(attemptsMade-1))` with
  base 1s, cap 5m; FULL jitter (`random() * exp`).
- **Un-jittered steps:** ~1s, 2s, 4s, 8s, 16s (then capped at 5m). With 6
  attempts a delivery reaches `dead` within a few minutes.
- **Why full jitter:** when a downed receiver recovers, thousands of pending
  deliveries would otherwise retry at the same instant (thundering herd). Full
  jitter spreads them uniformly across each backoff window.

### Error classification: retry 5xx / 429 / 408 / network / timeout only
- **What:** `isRetryableStatus` retries 5xx and the two transient 4xx (429, 408);
  all other 4xx are permanent. Network errors and timeouts (caught) are always
  retryable.
- **Why:** Engineering rule — a permanent 4xx (bad payload, unknown route) will
  never succeed, so retrying wastes attempts and hammers the receiver.

### Hard per-request timeout via AbortSignal.timeout
- **What:** Each POST uses `AbortSignal.timeout(DELIVERY_TIMEOUT_MS)` (default 8s).
- **Why:** Engineering rule — a hanging receiver must never block a worker slot.
  A timeout is classified retryable and recorded with a null status code.

### HMAC-SHA256 over `timestamp.body`, hex, `sha256=` prefix
- **What:** Sign `${timestamp}.${rawBody}`; send `X-Webhook-Signature`,
  `X-Webhook-Timestamp`, `X-Webhook-Id`. Verify with constant-time compare and
  reject timestamps outside a tolerance window (replay protection).
- **Why:** Signing the timestamp (not just the body) enables replay rejection and
  stops the timestamp being altered. Constant-time compare avoids leaking match
  progress via timing.
- **Trade-off:** Receiver and sender clocks must be within tolerance (default
  300s).

### Connection resilience: pool/redis error listeners
- **What:** Added `pool.on('error')` and `redis.on('error')` handlers.
- **Why:** A dropped idle Postgres connection emits an unhandled 'error' event
  that crashes the process (hit this live when Postgres cycled). ioredis
  auto-reconnects but also needs a handler. Both now log and recover.
- **Trade-off:** None; this is strictly more robust and applies to the API too.

### Chaos receiver
- **What:** A standalone Express receiver that randomly 200s / 500s / hangs, and
  verifies the HMAC when given a secret. Deterministic test knobs:
  `CHAOS_FORCE_STATUS`, `CHAOS_SUCCEED_AFTER`, `CHAOS_SECRET`.
- **Why:** Exercises real failure modes (engineering rule: don't mock away
  failures). Deliberately has no app-config dependency.

## CP4 Reliability

### DLQ = deliveries.status 'dead' (no separate Redis queue)
- **What:** The dead-letter queue is just `deliveries` rows with status='dead';
  BullMQ's retained failed jobs are secondary. `GET /deliveries?status=dead`
  lists it; `POST /deliveries/:id/replay` re-queues one.
- **Why:** Postgres is the source of truth; a DB-backed DLQ is durable and
  queryable, and avoids a second place that can disagree.
- **Trade-off:** Listing/replay go through SQL, not a queue API — fine at this scale.

### Replay resets to a fresh pending state and removes the stale job
- **What:** Replay sets status=pending, attempts_count=0, next_attempt_at=now,
  removes any job with jobId=deliveryId, then enqueues.
- **Why:** jobId dedupe would otherwise collapse the new enqueue into the old
  failed job. Attempt history is preserved in delivery_attempts.
- **Trade-off:** Only dead/failed are replayable (409 otherwise).

### Idempotency scoped to (application_id, idempotency_key)
- **What:** Replaced the global UNIQUE(idempotency_key) with a composite unique.
- **Why:** Keys are per-tenant; two apps must be able to reuse the same key.
  NULLs stay distinct so keyless events are never deduped.

### SSRF: block private/loopback/link-local, at creation AND delivery
- **What:** `assertUrlAllowed` rejects non-http(s), embedded credentials, and
  hosts resolving to loopback/private/link-local/CGNAT/multicast ranges. Checked
  at endpoint creation and again in the worker before each POST (DNS rebinding).
- **Why:** Engineering rule — customer URLs must not reach internal services or
  the cloud metadata endpoint (169.254.169.254).
- **Trade-off / dev:** The in-cluster chaos receiver is a private IP, so
  SSRF_ALLOW_PRIVATE=true is set in dev compose only; prod leaves it false.
  Re-resolving per delivery (not IP pinning) is a small residual rebinding window.

### Per-endpoint rate limit + concurrency cap (Redis)
- **What:** Fixed 1s-window rate limit and an in-flight concurrency counter per
  endpoint, enforced in the processor before the POST. Over a limit => the job is
  rescheduled via BullMQ moveToDelayed WITHOUT consuming a retry attempt.
- **Why:** Protect slow/limited receivers and share worker capacity fairly.
  Throttling is backpressure, not failure, so it must not burn the retry budget.
- **Trade-off:** Fixed-window rate limiting allows short bursts at window edges;
  good enough here. Values are per-endpoint columns (NULL => env default).

### Circuit breaker (per endpoint, Redis), open consumes an attempt
- **What:** closed -> open (after CB_FAILURE_THRESHOLD consecutive retryable
  failures) -> half-open (after CB_OPEN_MS, limited trials) -> closed on success.
  While open, the POST is skipped and the attempt is fast-failed.
- **Why:** Stop hammering a down endpoint and stop wasting worker slots on
  timeouts. Permanent 4xx do NOT trip it (client error, not availability).
- **Design choice:** an open-circuit skip still consumes a retry attempt, so a
  permanently-down endpoint still marches to the DLQ; the breaker only saves the
  network call + timeout wait. State is Redis (pragmatic, non-Lua).

### DB-write/enqueue gap: reconciling sweeper (dedicated scheduler)
- **What:** A single `scheduler` service runs sweepOnce() every SWEEP_INTERVAL_MS:
  it enqueues due 'pending' deliveries. jobId dedupe makes it idempotent and lets
  it rebuild the whole queue from Postgres if Redis is wiped.
- **Why:** Simplest fix that also satisfies "Redis state recoverable from
  Postgres". Chose it over a transactional outbox (stronger but more moving
  parts); publish's enqueue stays best-effort with the sweeper as backstop.
- **Trade-off:** A lost enqueue self-heals within one sweep interval (latency),
  rather than immediately as an outbox relay would.

## CP5 Observability and UI

### /metrics: DB-derived gauges + one in-process counter
- **What:** `GET /metrics` (prom-client) exposes default process metrics, a real
  counter `webhook_events_published_total` incremented in the publish route, and
  gauges derived from Postgres on each scrape: `webhook_deliveries{status}`,
  `webhook_events_total`, `webhook_delivery_attempts{result}`.
- **Why:** Deliveries run in the worker process, which this endpoint does not
  scrape. Rather than aggregate counters across processes, we read the counts
  from Postgres (the source of truth) at scrape time — correct across processes
  and restarts. The one real counter shows the code-incremented pattern too.
- **Trade-off:** DB-derived values are gauges, not monotonic counters, and each
  scrape runs a few COUNT queries (cheap at this scale; could be cached later).
  `/metrics` is unauthenticated by Prometheus convention (sits behind the
  private network in prod).

### Delivery status API
- **What:** `GET /deliveries/:id` returns the delivery plus its full attempt
  history; `GET /deliveries?status=` lists them. Both scoped to the caller's
  application (other tenants get 404).
- **Why:** The CP5 goal — "see attempts and status per delivery" — and it backs
  the dashboard.

### Minimal dashboard served inline
- **What:** `GET /dashboard` returns a single self-contained HTML page (vanilla
  JS, no build, no external libs): paste an API key, list deliveries, expand one
  to see attempts, replay dead/failed ones.
- **Why:** Kept deliberately minimal (not the project's focus). Served as an
  inline string so it needs no static-file packaging in the Docker image and
  works the same in dev and prod. The API key is sent only to this API and
  cached in the browser's localStorage for convenience.
- **Trade-off:** Not a real admin UI; no pagination/auth session. Fine for scope.

## CP6 Quality

### Vitest, with real Postgres + Redis (no hidden-failure mocks)
- **What:** Vitest for unit + integration tests. Integration tests run against the
  real compose Postgres/Redis, on an isolated test database (webhook_test) and
  Redis DB index (/1). Only the HTTP receiver is a local controllable server.
- **Why:** Engineering rule — don't mock in a way that hides real failure modes.
  Real DB enforces the real constraints (unique idempotency, FK cascades); real
  Redis exercises the real queue.
- **Trade-off:** Tests need infra available (compose locally, service containers
  in CI) — slower than pure mocks, but far more trustworthy.

### Delivery tests run the real BullMQ worker in-process
- **What:** Integration tests start a genuine Worker (helper mirroring
  src/worker/index.ts without signal handlers) and assert on resulting DB state,
  driven by a controllable receiver (ok / 500 / 400 / hang / succeed-after-N).
- **Why:** Exercises the true end-to-end path through the queue and processor.
- **Keeping it non-flaky:** test env shrinks the clock (BACKOFF_BASE_MS=50,
  cap 400, DELIVERY_TIMEOUT_MS=1000, MAX_ATTEMPTS=4) and a high breaker threshold
  so retry/DLQ cycles finish in ~1-2s; tests poll for state (waitFor) instead of
  sleeping; files run serially; truncate + flushdb between tests.
- **Trade-off:** A worker in-process is heavier than calling processDelivery
  directly, but gives real queue coverage. The chaos script covers real-clock
  timing separately.

### Chaos script separate from the fast CI lane
- **What:** scripts/chaos-test.mjs drives the full compose stack + flaky chaos
  receiver (retry->success, DLQ, replay, 100x idempotency, tamper->401). Not run
  in CI; invoked manually via `npm run chaos:test`.
- **Why:** It needs the whole compose and real timing (slow, timing-sensitive).
  Keeping it out of CI keeps CI fast and non-flaky; the deterministic suite
  covers the same behaviours quickly.

### CI: GitHub Actions with service containers
- **What:** .github/workflows/ci.yml runs on push/PR: Node 22, postgres:17 +
  redis:7 service containers, then lint -> tsc --noEmit -> build -> vitest.
  TEST_* env vars point tests at the service containers.
- **Why:** Mirrors the real stack (not mocks) and gives the CP6 done-when (green
  CI covering retry, DLQ, idempotency, signature). No secrets needed — a
  throwaway test password only.
