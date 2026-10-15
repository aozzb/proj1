import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { truncateAll, closeResources } from '../helpers/db';

const app = createApp();

beforeEach(truncateAll);
afterAll(closeResources);

async function register(name = 'app'): Promise<string> {
  const res = await request(app).post('/applications').send({ name });
  expect(res.status).toBe(201);
  return res.body.api_key as string;
}

describe('applications + auth', () => {
  it('registers and returns the API key once', async () => {
    const res = await request(app).post('/applications').send({ name: 'a' });
    expect(res.status).toBe(201);
    expect(res.body.api_key).toMatch(/^whsk_/);
  });

  it('authenticates with the key and rejects bad/missing keys', async () => {
    const key = await register();
    expect((await request(app).get('/applications/me').set('authorization', `Bearer ${key}`)).status).toBe(200);
    expect((await request(app).get('/applications/me').set('authorization', 'Bearer nope')).status).toBe(401);
    expect((await request(app).get('/applications/me')).status).toBe(401);
  });
});

describe('endpoints + publish validation', () => {
  it('creates an endpoint and returns its secret once', async () => {
    const key = await register();
    const res = await request(app)
      .post('/endpoints')
      .set('authorization', `Bearer ${key}`)
      .send({ url: 'http://example.com/hook', event_types: ['t'] });
    expect(res.status).toBe(201);
    expect(res.body.secret).toMatch(/^whsec_/);
  });

  it('rejects an event with no type (zod 400)', async () => {
    const key = await register();
    const res = await request(app)
      .post('/events')
      .set('authorization', `Bearer ${key}`)
      .send({ payload: {} });
    expect(res.status).toBe(400);
  });
});

describe('publish + idempotency', () => {
  it('fans out to a subscribed endpoint and 0 to unsubscribed types', async () => {
    const key = await register();
    await request(app).post('/endpoints').set('authorization', `Bearer ${key}`).send({ url: 'http://example.com/hook', event_types: ['order.created'] });

    const subscribed = await request(app).post('/events').set('authorization', `Bearer ${key}`).send({ type: 'order.created', payload: {} });
    expect(subscribed.status).toBe(202);
    expect(subscribed.body.deliveries_created).toBe(1);

    const unsubscribed = await request(app).post('/events').set('authorization', `Bearer ${key}`).send({ type: 'nobody.listens', payload: {} });
    expect(unsubscribed.body.deliveries_created).toBe(0);
  });

  it('dedupes a repeated idempotency_key (same event, replay flag)', async () => {
    const key = await register();
    const body = { type: 't', payload: { a: 1 }, idempotency_key: 'k1' };
    const first = await request(app).post('/events').set('authorization', `Bearer ${key}`).send(body);
    const second = await request(app).post('/events').set('authorization', `Bearer ${key}`).send(body);
    expect(first.body.event_id).toBe(second.body.event_id);
    expect(second.body.idempotent_replay).toBe(true);
  });

  it('scopes idempotency per application (same key, two apps = two events)', async () => {
    const keyA = await register('A');
    const keyB = await register('B');
    const a = await request(app).post('/events').set('authorization', `Bearer ${keyA}`).send({ type: 't', payload: {}, idempotency_key: 'shared' });
    const b = await request(app).post('/events').set('authorization', `Bearer ${keyB}`).send({ type: 't', payload: {}, idempotency_key: 'shared' });
    expect(a.body.event_id).not.toBe(b.body.event_id);
  });
});
