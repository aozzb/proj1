import { Router } from 'express';
import { asyncHandler } from '../lib/async-handler';
import { registry } from '../lib/metrics';

export const metricsRouter = Router();

/**
 * GET /metrics — Prometheus scrape endpoint. Unauthenticated by convention
 * (a scraper hits it); in production it would sit behind the private network.
 */
metricsRouter.get(
  '/metrics',
  asyncHandler(async (_req, res) => {
    res.set('Content-Type', registry.contentType);
    res.send(await registry.metrics());
  })
);
