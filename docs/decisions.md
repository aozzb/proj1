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

### Logging: pino with a redaction list from day one
- **What:** One shared pino logger; redaction paths for auth headers, secrets,
  and API keys are configured before any such data exists.
- **Why:** Engineering rule — never log secrets. Setting redaction up front
  makes "don't leak" the default rather than something to remember later.
- **Trade-off:** Must keep the redaction path list in sync with new secret-ish
  fields.
