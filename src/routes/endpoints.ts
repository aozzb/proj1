import { Router } from 'express';
import { pool } from '../lib/db';
import { generateSecret } from '../lib/crypto';
import { asyncHandler } from '../lib/async-handler';
import { validateBody } from '../middleware/validate';
import { apiKeyAuth } from '../middleware/auth';
import { createEndpointSchema } from '../schemas';

export const endpointsRouter = Router();

/**
 * POST /endpoints  (auth required)
 * Registers a delivery destination for the authenticated application and
 * generates its HMAC signing secret. The secret is returned ONCE — the receiver
 * needs it to verify signatures (CP3).
 */
endpointsRouter.post(
  '/endpoints',
  apiKeyAuth,
  validateBody(createEndpointSchema),
  asyncHandler(async (req, res) => {
    const { url, event_types } = req.body as { url: string; event_types: string[] };
    const secret = generateSecret();

    const { rows } = await pool.query(
      `INSERT INTO endpoints (application_id, url, secret, event_types)
       VALUES ($1, $2, $3, $4)
       RETURNING id, url, status, event_types, created_at`,
      [req.application!.id, url, secret, event_types]
    );

    res.status(201).json({ ...rows[0], secret });
  })
);
