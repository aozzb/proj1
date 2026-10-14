/* eslint-disable camelcase */

/**
 * Idempotency keys are a per-application concept: two different applications
 * must be able to use the same key (e.g. "order-1") independently. CP2 made the
 * key globally UNIQUE; scope it to (application_id, idempotency_key).
 *
 * NULLs stay distinct under a composite UNIQUE, so keyless events are still
 * never deduped.
 */

exports.shorthands = undefined;

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE events DROP CONSTRAINT IF EXISTS events_idempotency_key_key;
    ALTER TABLE events
      ADD CONSTRAINT events_app_idempotency_key_unique
      UNIQUE (application_id, idempotency_key);
  `);
};

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE events DROP CONSTRAINT IF EXISTS events_app_idempotency_key_unique;
    ALTER TABLE events
      ADD CONSTRAINT events_idempotency_key_key UNIQUE (idempotency_key);
  `);
};
