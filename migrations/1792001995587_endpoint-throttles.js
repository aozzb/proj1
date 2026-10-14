/* eslint-disable camelcase */

/**
 * Per-endpoint delivery throttles (CP4). Nullable: NULL means "use the service
 * default" (env ENDPOINT_RATE_LIMIT_PER_SEC / ENDPOINT_MAX_CONCURRENCY), so
 * existing endpoints are unaffected.
 */

exports.shorthands = undefined;

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE endpoints
      ADD COLUMN IF NOT EXISTS rate_limit_per_sec integer,
      ADD COLUMN IF NOT EXISTS max_concurrency integer;
  `);
};

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE endpoints
      DROP COLUMN IF EXISTS rate_limit_per_sec,
      DROP COLUMN IF EXISTS max_concurrency;
  `);
};
