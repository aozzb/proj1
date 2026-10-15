import { pool } from '../../src/lib/db';
import { redis } from '../../src/lib/redis';
import { deliveryQueue } from '../../src/lib/queue';

/** Wipe all tables and the (test) Redis index for a clean slate between tests. */
export async function truncateAll(): Promise<void> {
  await pool.query(
    'TRUNCATE delivery_attempts, deliveries, events, endpoints, applications RESTART IDENTITY CASCADE'
  );
  await redis.flushdb();
}

/** Close shared connections so the test process exits cleanly (no open handles). */
export async function closeResources(): Promise<void> {
  await deliveryQueue.close();
  await pool.end();
  await redis.quit();
}

export async function deliveryStatus(eventId: string): Promise<string | undefined> {
  const { rows } = await pool.query<{ status: string }>(
    'SELECT status FROM deliveries WHERE event_id = $1',
    [eventId]
  );
  return rows[0]?.status;
}

export async function attemptCount(eventId: string): Promise<number> {
  const { rows } = await pool.query<{ c: string }>(
    `SELECT count(*)::int AS c
     FROM delivery_attempts a JOIN deliveries d ON d.id = a.delivery_id
     WHERE d.event_id = $1`,
    [eventId]
  );
  return Number(rows[0].c);
}

export async function deliveryIdFor(eventId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM deliveries WHERE event_id = $1',
    [eventId]
  );
  return rows[0].id;
}
