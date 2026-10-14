import { Worker } from 'bullmq';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { redis, closeRedis } from '../lib/redis';
import { closeDb } from '../lib/db';
import { DELIVERY_QUEUE, type DeliveryJobData } from '../lib/queue';
import { processDelivery } from './processor';
import { backoffDelay } from './backoff';

/**
 * The delivery worker process. Consumes jobs from the `deliveries` queue and
 * runs the delivery processor. Retry scheduling is BullMQ-native: `attempts`
 * comes from the job, and the custom backoff strategy supplies the delay.
 */
const worker = new Worker<DeliveryJobData>(DELIVERY_QUEUE, processDelivery, {
  connection: redis,
  concurrency: env.WORKER_CONCURRENCY,
  settings: {
    // BullMQ calls this with the post-increment attempt count.
    backoffStrategy: (attemptsMade: number) => backoffDelay(attemptsMade),
  },
});

worker.on('failed', (job, err) => {
  logger.warn({ jobId: job?.id, err: err.message }, 'job failed (retry or dead)');
});
worker.on('error', (err) => {
  logger.error({ err }, 'worker error');
});

logger.info(
  { concurrency: env.WORKER_CONCURRENCY, maxAttempts: env.MAX_ATTEMPTS },
  'delivery worker started'
);

/**
 * Graceful shutdown: worker.close() stops picking up new jobs and waits for
 * in-flight jobs to finish (BullMQ releases their locks if interrupted), then
 * we close DB and Redis. A hard timeout guards against a stuck job.
 */
async function shutdown(signal: string) {
  logger.info({ signal }, 'worker shutting down');

  const forced = setTimeout(() => {
    logger.error('forced worker shutdown after timeout');
    process.exit(1);
  }, 15_000);
  forced.unref();

  try {
    await worker.close();
    await Promise.allSettled([closeRedis(), closeDb()]);
    logger.info('worker shutdown complete');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'error during worker shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
