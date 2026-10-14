import { Router } from 'express';
import { pool } from '../lib/db';
import { generateSecret } from '../lib/crypto';
import { asyncHandler } from '../lib/async-handler';
import { validateBody } from '../middleware/validate';
import { apiKeyAuth } from '../middleware/auth';
import { createEndpointSchema } from '../schemas';
import { assertUrlAllowed, SsrfBlockedError } from '../lib/ssrf';

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
    const { url, event_types, rate_limit_per_sec, max_concurrency } = req.body as {
      url: string;
      event_types: string[];
      rate_limit_per_sec?: number;
      max_concurrency?: number;
    };

    // SSRF: reject URLs that target private/loopback/link-local addresses.
    try {
      await assertUrlAllowed(url);
    } catch (err) {
      if (err instanceof SsrfBlockedError) {
        res.status(400).json({ error: 'url rejected', reason: err.message });
        return;
      }
      throw err;
    }

    const secret = generateSecret();

    const { rows } = await pool.query(
      `INSERT INTO endpoints
         (application_id, url, secret, event_types, rate_limit_per_sec, max_concurrency)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, url, status, event_types, rate_limit_per_sec, max_concurrency, created_at`,
      [req.application!.id, url, secret, event_types, rate_limit_per_sec ?? null, max_concurrency ?? null]
    );

    res.status(201).json({ ...rows[0], secret });
  })
);
