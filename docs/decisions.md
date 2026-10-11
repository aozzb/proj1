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
