import client from 'prom-client';
import { pool } from './db';

/**
 * Prometheus metrics for the API process.
 *
 * Delivery/event counts are derived from Postgres on each scrape (via gauge
 * `collect` callbacks) rather than from in-process counters. This is deliberate:
 * deliveries are processed in the worker process, which Prometheus does not
 * scrape here, and Postgres is the source of truth — so DB-derived values stay
 * correct across processes and across restarts.
 *
 * `webhook_events_published_total` is a genuine in-process counter incremented
 * by the API on publish, to show a code-incremented counter alongside the gauges.
 */
export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

/** Incremented in the publish route. */
export const eventsPublishedCounter = new client.Counter({
  name: 'webhook_events_published_total',
  help: 'Events accepted by POST /events (this process)',
  registers: [registry],
});

const DELIVERY_STATUSES = ['pending', 'succeeded', 'failed', 'dead'];

new client.Gauge({
  name: 'webhook_deliveries',
  help: 'Current number of deliveries by status',
  labelNames: ['status'],
  registers: [registry],
  async collect() {
    const { rows } = await pool.query<{ status: string; c: string }>(
      'SELECT status, count(*)::int AS c FROM deliveries GROUP BY status'
    );
    const counts = new Map(rows.map((r) => [r.status, Number(r.c)]));
    for (const s of DELIVERY_STATUSES) this.set({ status: s }, counts.get(s) ?? 0);
  },
});

new client.Gauge({
  name: 'webhook_events_total',
  help: 'Total events stored',
  registers: [registry],
  async collect() {
    const { rows } = await pool.query<{ c: string }>('SELECT count(*)::int AS c FROM events');
    this.set(Number(rows[0].c));
  },
});

new client.Gauge({
  name: 'webhook_delivery_attempts',
  help: 'Total delivery attempts by result class',
  labelNames: ['result'],
  registers: [registry],
  async collect() {
    const { rows } = await pool.query<{ result: string; c: string }>(
      `SELECT CASE
                WHEN status_code IS NULL THEN 'error'
                WHEN status_code BETWEEN 200 AND 299 THEN 'success'
                ELSE 'failure'
              END AS result,
              count(*)::int AS c
       FROM delivery_attempts GROUP BY 1`
    );
    for (const r of ['success', 'failure', 'error']) this.set({ result: r }, 0);
    for (const r of rows) this.set({ result: r.result }, Number(r.c));
  },
});
