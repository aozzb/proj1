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