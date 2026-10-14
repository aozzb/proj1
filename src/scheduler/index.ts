import { env } from '../config/env';
import { logger } from '../lib/logger';
import { closeDb } from '../lib/db';
import { closeRedis } from '../lib/redis';
import { sweepOnce } from './sweeper';

/**
 * The scheduler process. Runs the reconciling sweep on a fixed interval. Kept as
 * a single dedicated service so there is exactly one sweeper (unlike the worker,
 * which scales out).
 */
let running = false;

async function tick() {
  if (running) return; // never let two sweeps overlap
  running = true;
  try {
    await sweepOnce();
  } catch (err) {
    logger.error({ err }, 'sweep failed');
  } finally {
    running = false;
  }
}

const interval = setInterval(() => void tick(), env.SWEEP_INTERVAL_MS);

logger.info(
  { intervalMs: env.SWEEP_INTERVAL_MS, batch: env.SWEEP_BATCH },
  'scheduler started (reconciling sweeper)'
);

async function shutdown(signal: string) {
  logger.info({ signal }, 'scheduler shutting down');
  clearInterval(interval);
  try {
    await Promise.allSettled([closeRedis(), closeDb()]);
    logger.info('scheduler shutdown complete');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'error during scheduler shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
