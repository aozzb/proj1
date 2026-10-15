import { Worker } from 'bullmq';
import { redis } from '../../src/lib/redis';
import { env } from '../../src/config/env';
import { DELIVERY_QUEUE, type DeliveryJobData } from '../../src/lib/queue';
import { processDelivery } from '../../src/worker/processor';
import { backoffDelay } from '../../src/worker/backoff';

/**
 * Construct a real BullMQ worker for tests, mirroring src/worker/index.ts but
 * without the process-level signal handlers / logging side effects. Deliveries
 * run through the genuine queue + processor against the real test DB.
 */
export function startTestWorker(): Worker<DeliveryJobData> {
  return new Worker<DeliveryJobData>(DELIVERY_QUEUE, processDelivery, {
    connection: redis,
    concurrency: env.WORKER_CONCURRENCY,
    settings: {
      backoffStrategy: (attemptsMade: number) => backoffDelay(attemptsMade),
    },
  });
}
