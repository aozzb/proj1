import { Queue } from 'bullmq';
import { redis } from './redis';

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
  await deliveryQueue.add(
    'deliver',
    { deliveryId },
    { jobId: deliveryId, removeOnComplete: true, removeOnFail: false }
  );
}
