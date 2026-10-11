import { Router } from 'express';
import { pool } from '../lib/db';
import { asyncHandler } from '../lib/async-handler';
import { validateBody } from '../middleware/validate';
import { apiKeyAuth } from '../middleware/auth';
import { publishEventSchema } from '../schemas';
import { enqueueDelivery } from '../lib/queue';
import { logger } from '../lib/logger';

export const eventsRouter = Router();

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

/**
 * POST /events  (auth required) — the core publish flow.
 *
 * 1. (optional) idempotency: a repeated idempotency_key returns the existing event.
 * 2. insert the event.
 * 3. fan out: find the app's active endpoints subscribed to this event type.
 * 4. create one delivery per endpoint (ON CONFLICT DO NOTHING on the unique pair).
 * 5. enqueue a job per newly-created delivery.
 */
eventsRouter.post(
  '/events',
  apiKeyAuth,
  validateBody(publishEventSchema),
  asyncHandler(async (req, res) => {
    const appId = req.application!.id;
    const { type, payload, idempotency_key } = req.body as {
      type: string;
      payload: Record<string, unknown>;
      idempotency_key?: string;
    };

    // 1. Idempotency fast path: already seen this key -> return the same event.
    if (idempotency_key) {
      const existing = await pool.query('SELECT id FROM events WHERE idempotency_key = $1', [
        idempotency_key,
      ]);
      if (existing.rows.length > 0) {
        res.status(200).json({ event_id: existing.rows[0].id, idempotent_replay: true });
        return;
      }
    }

    // 2. Insert the event. Handle the race where two requests with the same key
    // arrive together: the UNIQUE constraint makes the loser a 23505, which we
    // translate back into the idempotent-replay response.
    let eventId: string;
    try {
      const ins = await pool.query(
        `INSERT INTO events (application_id, type, payload, idempotency_key)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [appId, type, payload, idempotency_key ?? null]
      );
      eventId = ins.rows[0].id;
    } catch (err) {
      if (idempotency_key && isUniqueViolation(err)) {
        const existing = await pool.query('SELECT id FROM events WHERE idempotency_key = $1', [
          idempotency_key,
        ]);
        res.status(200).json({ event_id: existing.rows[0].id, idempotent_replay: true });
        return;
      }
      throw err;
    }

    // 3. Fan out to subscribed, active endpoints.
    const endpoints = await pool.query<{ id: string }>(
      `SELECT id FROM endpoints
       WHERE application_id = $1 AND status = 'active' AND event_types @> ARRAY[$2]::text[]`,
      [appId, type]
    );

    // 4 + 5. Create deliveries and enqueue jobs.
    let created = 0;
    for (const ep of endpoints.rows) {
      const del = await pool.query<{ id: string }>(
        `INSERT INTO deliveries (event_id, endpoint_id)
         VALUES ($1, $2)
         ON CONFLICT (event_id, endpoint_id) DO NOTHING
         RETURNING id`,
        [eventId, ep.id]
      );

      if (del.rows.length > 0) {
        // CP4 GAP: the delivery row is committed above, but if the process dies
        // here (before/while enqueuing) the delivery is left 'pending' with no
        // job — a lost webhook. CP4 closes this with an outbox or a reconciling
        // sweeper that re-enqueues pending deliveries that have no live job.
        await enqueueDelivery(del.rows[0].id);
        created++;
      }
    }

    logger.info({ eventId, type, deliveriesCreated: created }, 'event published');
    res.status(202).json({ event_id: eventId, deliveries_created: created });
  })
);
