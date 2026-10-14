import { Queue } from 'bullmq';
import { redis } from './redis';
import { env } from '../config/env';

/**
 * Producer side of the delivery queue. CP2 only enqueues jobs; the consumer
 * (worker) that actually POSTs to receivers arrives in CP3.
 *
 * A job carries just the delivery id — Postgres is the source of truth, so the
 * worker will load the full delivery/event/endpoint rows by id rather than
 * trusting data baked into the job.
 */
export const DELIVERY_QUEUE = 'deliveries';

export interface DeliveryJobData {
  deliveryId: string;
}

export const deliveryQueue = new Queue<DeliveryJobData>(DELIVERY_QUEUE, {
  connection: redis,
});

export async function enqueueDelivery(deliveryId: string): Promise<void> {
  // jobId = deliveryId gives us queue-level dedupe: re-enqueuing the same
  // delivery (e.g. a retried publish) collapses to one job. Belt-and-braces on
  // top of the UNIQUE(event_id, endpoint_id) row constraint.
  //
  // attempts + custom backoff drive the retry schedule (CP3). removeOnFail is
  // kept false so exhausted deliveries stay in the failed set for the CP4 DLQ.
  await deliveryQueue.add(
    'deliver',
    { deliveryId },
    {
      jobId: deliveryId,
      attempts: env.MAX_ATTEMPTS,
      backoff: { type: 'custom' },
      removeOnComplete: true,
      removeOnFail: false,
    }
  );
}
