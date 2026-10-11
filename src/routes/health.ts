import { Router } from 'express';
import { pingDb } from '../lib/db';
import { pingRedis } from '../lib/redis';

export const healthRouter = Router();

/**
 * GET /health
 * Returns 200 only when both Postgres and Redis respond. We probe them in
 * parallel and report each dependency individually so a failing dependency is
 * obvious at a glance. Returns 503 if anything is down.
 */
healthRouter.get('/health', async (_req, res) => {
  const [db, redis] = await Promise.all([
    pingDb().then(
      () => ({ ok: true }) as const,
      (err: unknown) => ({ ok: false, error: String(err) }) as const
    ),
    pingRedis().then(
      () => ({ ok: true }) as const,
      (err: unknown) => ({ ok: false, error: String(err) }) as const
    ),
  ]);

  const ok = db.ok && redis.ok;
  res.status(ok ? 200 : 503).json({
    status: ok ? 'ok' : 'degraded',
    checks: { postgres: db, redis },
  });
});
