import { Router } from 'express';
import { pool } from '../lib/db';
import { asyncHandler } from '../lib/async-handler';
import { apiKeyAuth } from '../middleware/auth';
import { deliveryQueue, enqueueDelivery } from '../lib/queue';
import { logger } from '../lib/logger';

export const deliveriesRouter = Router();

const ALLOWED_STATUS = new Set(['pending', 'succeeded', 'failed', 'dead']);

/**
 * GET /deliveries?status=dead&limit=50  (auth required)
 * Lists the authenticated application's deliveries, optionally filtered by
 * status. status=dead is effectively the dead-letter queue.
 */
deliveriesRouter.get(
  '/deliveries',
  apiKeyAuth,
  asyncHandler(async (req, res) => {
    const appId = req.application!.id;
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    if (status && !ALLOWED_STATUS.has(status)) {
      res.status(400).json({ error: `invalid status; one of ${[...ALLOWED_STATUS].join(', ')}` });
      return;
    }
    const limit = Math.min(Number(req.query.limit) || 50, 200);

    const { rows } = await pool.query(
      `SELECT d.id, d.status, d.attempts_count, d.next_attempt_at, d.last_error,
              d.event_id, d.endpoint_id, d.created_at, d.updated_at
       FROM deliveries d
       JOIN events e ON e.id = d.event_id
       WHERE e.application_id = $1
         AND ($2::text IS NULL OR d.status = $2)
       ORDER BY d.updated_at DESC
       LIMIT $3`,
      [appId, status ?? null, limit]
    );
    res.json({ deliveries: rows });
  })
);

/**
 * POST /deliveries/:id/replay  (auth required)
 * Re-queues a dead or failed delivery: reset to pending with a fresh attempt
 * budget, remove any stale queue job, and enqueue again. Succeeded/pending
 * deliveries are not replayable.
 */
deliveriesRouter.post(
  '/deliveries/:id/replay',
  apiKeyAuth,
  asyncHandler(async (req, res) => {
    const appId = req.application!.id;
    const deliveryId = req.params.id;

    // Ownership + eligibility check (delivery belongs to this app via its event).
    const { rows } = await pool.query<{ status: string }>(
      `SELECT d.status
       FROM deliveries d
       JOIN events e ON e.id = d.event_id
       WHERE d.id = $1 AND e.application_id = $2`,
      [deliveryId, appId]
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'delivery not found' });
      return;
    }
    const status = rows[0].status;
    if (status !== 'dead' && status !== 'failed') {
      res.status(409).json({ error: `only dead/failed deliveries can be replayed (status=${status})` });
      return;
    }

    // Reset the row to a fresh pending state. attempts history stays in
    // delivery_attempts; attempts_count resets so the replay gets a full budget.
    await pool.query(
      `UPDATE deliveries
       SET status = 'pending', attempts_count = 0, next_attempt_at = now(), last_error = NULL
       WHERE id = $1`,
      [deliveryId]
    );

    // Remove any stale job (jobId = deliveryId) so the fresh enqueue is not
    // deduped against the old failed job, then enqueue.
    const stale = await deliveryQueue.getJob(deliveryId);
    if (stale) {
      await stale.remove().catch(() => undefined);
    }
    await enqueueDelivery(deliveryId);

    logger.info({ deliveryId, previousStatus: status }, 'delivery replayed');
    res.status(202).json({ delivery_id: deliveryId, status: 'pending' });
  })
);
