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