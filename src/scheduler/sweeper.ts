import { pool } from '../lib/db';
import { enqueueDelivery } from '../lib/queue';
import { env } from '../config/env';
import { logger } from '../lib/logger';

/**
 * Reconciling sweep: the backstop for the DB-write/enqueue gap.
 *
 * Publish commits the delivery row before enqueuing; if the process dies in
 * between, the delivery is left 'pending' with no queue job. This sweep finds
 * pending deliveries whose next_attempt_at is due and (re-)enqueues them.
 *
 * It is safe to run repeatedly: because jobId = deliveryId, any delivery that
 * already has a waiting/delayed/active job is deduped and the add() is a no-op.
 * This also makes the queue fully rebuildable from Postgres if Redis is wiped.
 */
export async function sweepOnce(): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM deliveries
     WHERE status = 'pending' AND next_attempt_at <= now()
     ORDER BY next_attempt_at ASC
     LIMIT $1`,
    [env.SWEEP_BATCH]
  );

  let enqueued = 0;
  for (const row of rows) {
    await enqueueDelivery(row.id);
    enqueued++;
  }
  if (enqueued > 0) {
    logger.info({ enqueued }, 'sweeper re-enqueued due pending deliveries');
  }
  return enqueued;
}
