/* eslint-disable camelcase */

/**
 * CP1 initial schema for the webhook delivery service.
 *
 * Written as raw SQL (via pgm.sql) rather than the pgm builder so the schema —
 * constraints, indexes, defaults — is fully visible and explainable. Postgres
 * is the source of truth; everything the worker and APIs rely on is enforced
 * here, not only in application code.
 *
 * Design choices (see docs/decisions.md for the why/trade-off):
 *  - UUID primary keys (gen_random_uuid) for rows whose id is exposed to the
 *    outside world (events, deliveries) or referenced in headers/logs.
 *  - delivery_attempts uses bigserial: a high-volume, append-only, internal log
 *    where natural insertion order is useful and the id is never exposed.
 *  - Status fields are text + CHECK rather than native ENUM types, so we can add
 *    states as the state machine grows without an ALTER TYPE dance.
 */

exports.shorthands = undefined;

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.sql(`
    -- gen_random_uuid() lives in pgcrypto on older PG; harmless if already present.
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    -- Shared trigger: keep updated_at current on UPDATE.
    CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
    BEGIN
      NEW.updated_at = now();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    -- applications: the tenant. Owns endpoints and events.
    -- API keys are stored hashed only (engineering rule: store keys hashed).
    CREATE TABLE applications (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name          text NOT NULL,
      api_key_hash  text NOT NULL UNIQUE,
      created_at    timestamptz NOT NULL DEFAULT now()
    );

    -- endpoints: a destination URL belonging to an application.
    -- event_types is the set of event types this endpoint is subscribed to.
    CREATE TABLE endpoints (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
      url            text NOT NULL,
      secret         text NOT NULL,                 -- per-endpoint HMAC signing secret
      status         text NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'paused', 'disabled')),
      event_types    text[] NOT NULL DEFAULT '{}',  -- subscribed event types
      created_at     timestamptz NOT NULL DEFAULT now(),
      updated_at     timestamptz NOT NULL DEFAULT now()
    );

    -- Find all endpoints subscribed to a given event type: WHERE event_types @> ARRAY[$1].
    CREATE INDEX endpoints_event_types_idx ON endpoints USING gin (event_types);
    CREATE INDEX endpoints_application_id_idx ON endpoints (application_id);

    CREATE TRIGGER endpoints_set_updated_at
      BEFORE UPDATE ON endpoints
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- events: something that happened, published by a customer.
    -- idempotency_key is UNIQUE but nullable: Postgres treats NULLs as distinct,
    -- so events published without a key are never deduped, while two publishes
    -- with the same key collapse to one row (CP4 relies on this).
    CREATE TABLE events (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      application_id   uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
      type             text NOT NULL,
      payload          jsonb NOT NULL,
      idempotency_key  text UNIQUE,
      created_at       timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX events_application_id_idx ON events (application_id);

    -- deliveries: one row per (event x endpoint) — "we owe this endpoint this event".
    -- UNIQUE(event_id, endpoint_id) is the backbone of at-least-once-without-dupes:
    -- it guarantees we can create at most one delivery obligation per pair, so a
    -- retried enqueue can safely INSERT ... ON CONFLICT DO NOTHING.
    CREATE TABLE deliveries (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      event_id        uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      endpoint_id     uuid NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
      status          text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'succeeded', 'failed', 'dead')),
      attempts_count  integer NOT NULL DEFAULT 0,
      next_attempt_at timestamptz NOT NULL DEFAULT now(),
      last_error      text,
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT deliveries_event_endpoint_unique UNIQUE (event_id, endpoint_id)
    );

    -- The worker's hot query: "pending deliveries whose next_attempt_at is due".
    -- Partial index keeps it tiny — only rows still in flight are indexed.
    CREATE INDEX deliveries_due_idx
      ON deliveries (next_attempt_at)
      WHERE status = 'pending';

    CREATE INDEX deliveries_endpoint_id_idx ON deliveries (endpoint_id);

    CREATE TRIGGER deliveries_set_updated_at
      BEFORE UPDATE ON deliveries
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- delivery_attempts: append-only audit log, one row per POST attempt.
    -- Never updated, only inserted. bigserial gives natural ordering.
    CREATE TABLE delivery_attempts (
      id                bigserial PRIMARY KEY,
      delivery_id       uuid NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
      attempt_number    integer NOT NULL,
      status_code       integer,       -- HTTP status from receiver, null on network error/timeout
      latency_ms        integer,
      error             text,          -- error class/message when no HTTP response
      response_snippet  text,          -- truncated receiver response body
      created_at        timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX delivery_attempts_delivery_id_idx
      ON delivery_attempts (delivery_id, attempt_number);
  `);
};

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS delivery_attempts;
    DROP TABLE IF EXISTS deliveries;
    DROP TABLE IF EXISTS events;
    DROP TABLE IF EXISTS endpoints;
    DROP TABLE IF EXISTS applications;
    DROP FUNCTION IF EXISTS set_updated_at();
  `);
};
