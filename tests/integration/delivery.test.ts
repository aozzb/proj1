import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Worker } from 'bullmq';
import { createApp } from '../../src/app';
import { startReceiver, type TestReceiver } from '../helpers/receiver';
import { startTestWorker } from '../helpers/worker';
import {
  truncateAll,
  closeResources,
  deliveryStatus,
  attemptCount,
  deliveryIdFor,
} from '../helpers/db';
import { waitFor } from '../helpers/wait';

const app = createApp();
let worker: Worker;
let receiver: TestReceiver;

beforeAll(async () => {
  receiver = await startReceiver();
  worker = startTestWorker();
});
afterAll(async () => {
  await worker.close();
  await receiver.close();
  await closeResources();
});
beforeEach(async () => {
  await truncateAll();
  receiver.reset();
});

async function setup(types = ['t']): Promise<string> {
  const key = (await request(app).post('/applications').send({ name: 'd' })).body.api_key as string;
  const ep = await request(app)
    .post('/endpoints')
    .set('authorization', `Bearer ${key}`)
    .send({ url: receiver.url, event_types: types });
  receiver.setSecret(ep.body.secret);
  return key;
}
async function publish(key: string, type = 't'): Promise<string> {
  const res = await request(app)
    .post('/events')
    .set('authorization', `Bearer ${key}`)
    .send({ type, payload: { n: Math.random() } });
  expect(res.status).toBe(202);
  return res.body.event_id as string;
}
const untilStatus = (eventId: string, s: string) =>
  waitFor(() => deliveryStatus(eventId).then((v) => (v === s ? v : undefined)), { label: s, timeout: 15000 });

describe('delivery via the real worker', () => {
  it('delivers successfully and the receiver verifies the signature', async () => {
    const key = await setup();
    receiver.setMode('ok');
    const eventId = await publish(key);
    await untilStatus(eventId, 'succeeded');
    expect(await attemptCount(eventId)).toBe(1);
    expect(receiver.received.some((r) => r.sigValid === true)).toBe(true);
  });

  it('retries a flaky endpoint and eventually succeeds', async () => {
    const key = await setup();
    receiver.setMode('succeed-after', 2); // fail attempts 1 & 2, succeed on 3
    const eventId = await publish(key);
    await untilStatus(eventId, 'succeeded');
    expect(await attemptCount(eventId)).toBe(3);
  });

  it('does NOT retry a permanent 4xx (marks failed after one attempt)', async () => {
    const key = await setup();
    receiver.setMode('400');
    const eventId = await publish(key);
    await untilStatus(eventId, 'failed');
    expect(await attemptCount(eventId)).toBe(1);
  });

  it('exhausts retries on a persistent 5xx and lands in the DLQ (dead)', async () => {
    const key = await setup();
    receiver.setMode('500');
    const eventId = await publish(key);
    await untilStatus(eventId, 'dead');
    expect(await attemptCount(eventId)).toBe(4); // MAX_ATTEMPTS in test env
  });

  it('times out a hanging receiver and retries it', async () => {
    const key = await setup();
    receiver.setMode('hang');
    const eventId = await publish(key);
    await untilStatus(eventId, 'dead');
    // At least one attempt recorded a timeout (null status code).
    const { pool } = await import('../../src/lib/db');
    const { rows } = await pool.query<{ c: string }>(
      `SELECT count(*)::int AS c FROM delivery_attempts a JOIN deliveries d ON d.id=a.delivery_id
       WHERE d.event_id=$1 AND a.status_code IS NULL`,
      [eventId]
    );
    expect(Number(rows[0].c)).toBeGreaterThan(0);
  });

  it('replays a dead delivery and it then succeeds', async () => {
    const key = await setup();
    receiver.setMode('500');
    const eventId = await publish(key);
    await untilStatus(eventId, 'dead');
    const deliveryId = await deliveryIdFor(eventId);

    receiver.setMode('ok');
    const res = await request(app)
      .post(`/deliveries/${deliveryId}/replay`)
      .set('authorization', `Bearer ${key}`);
    expect(res.status).toBe(202);
    await untilStatus(eventId, 'succeeded');
  });
});
