import { Router } from 'express';
import { pool } from '../lib/db';
import { generateApiKey, hashApiKey } from '../lib/crypto';
import { asyncHandler } from '../lib/async-handler';
import { validateBody } from '../middleware/validate';
import { apiKeyAuth } from '../middleware/auth';
import { createApplicationSchema } from '../schemas';

export const applicationsRouter = Router();

/**
 * POST /applications  (unauthenticated bootstrap)
 * Registers an application and returns its API key ONCE. We store only the
 * hash, so the raw key cannot be recovered later.
 */
applicationsRouter.post(
  '/applications',
  validateBody(createApplicationSchema),
  asyncHandler(async (req, res) => {
    const { name } = req.body as { name: string };

    const apiKey = generateApiKey();
    const apiKeyHash = hashApiKey(apiKey);

    const { rows } = await pool.query(
      `INSERT INTO applications (name, api_key_hash)
       VALUES ($1, $2)
       RETURNING id, name, created_at`,
      [name, apiKeyHash]
    );

    res.status(201).json({ ...rows[0], api_key: apiKey });
  })
);

/**
 * GET /applications/me
 * Tiny authenticated read, handy for confirming an API key works.
 */
applicationsRouter.get('/applications/me', apiKeyAuth, (req, res) => {
  res.json(req.application);
});
