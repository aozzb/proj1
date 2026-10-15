#!/usr/bin/env node
// Automated chaos test: runs against the live `docker compose` stack and the
// flaky chaos receiver. Proves the real end-to-end behaviour (BullMQ timing,
// retries, DLQ, replay, idempotency, signature verification) that the fast unit
// /integration suite deliberately does not depend on timing for.
//
// Usage: docker compose up -d && node scripts/chaos-test.mjs
import { execSync } from 'node:child_process';
import { createHmac } from 'node:crypto';

const API = process.env.API_URL || 'http://localhost:3000';
const CHAOS = process.env.CHAOS_URL || 'http://localhost:4000';

let failures = 0;
const ok = (m) => console.log(`  PASS  ${m}`);
const bad = (m) => {
  console.log(`  FAIL  ${m}`);
  failures++;
};
const assert = (cond, passMsg, failMsg) => void (cond ? ok(passMsg) : bad(failMsg));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, { key, body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}

function recreateChaos(env) {
  execSync('docker compose up -d chaos-receiver', {
    env: { ...process.env, ...env },
    stdio: 'ignore',
  });
}

async function pollDelivery(id, key, target, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const { body } = await api('GET', `/deliveries/${id}`, { key });
    if (body && body.status === target) return true;
    await sleep(1000);
  }
  return false;
}

async function main() {
  console.log('== chaos test ==');
  const app = await api('POST', '/applications', { body: { name: 'chaos-test' } });
  const key = app.body.api_key;
  const ep = await api('POST', '/endpoints', {
    key,
    body: { url: 'http://chaos-receiver:4000/hook', event_types: ['c'] },
  });
  const secret = ep.body.secret;

  // Scenario A: flaky receiver (fail twice, then succeed) -> eventual success.
  console.log('[A] retry + backoff -> eventual success');
  recreateChaos({ CHAOS_SUCCEED_AFTER: '2', CHAOS_SECRET: secret });
  await sleep(3000);
  const a = await api('POST', '/events', { key, body: { type: 'c', payload: { s: 'A' } } });
  const aDid = (await api('GET', '/deliveries', { key })).body.deliveries.find(
    (d) => d.event_id === a.body.event_id
  )?.id;
  assert(await pollDelivery(aDid, key, 'succeeded', 60000), 'flaky delivery eventually succeeded', 'flaky delivery did not succeed');

  // Scenario B: persistent 500 -> dead-letter queue.
  console.log('[B] persistent 5xx -> DLQ (dead)');
  recreateChaos({ CHAOS_FORCE_STATUS: '500', CHAOS_SECRET: secret });
  await sleep(3000);
  const b = await api('POST', '/events', { key, body: { type: 'c', payload: { s: 'B' } } });
  const bDid = (await api('GET', '/deliveries', { key })).body.deliveries.find(
    (d) => d.event_id === b.body.event_id
  )?.id;
  assert(await pollDelivery(bDid, key, 'dead', 120000), 'persistent failure landed in DLQ', 'delivery did not reach DLQ');

  // Scenario C: fix receiver, replay the dead delivery -> success.
  console.log('[C] replay a dead delivery -> success');
  recreateChaos({ CHAOS_FORCE_STATUS: '200', CHAOS_SECRET: secret });
  // Sustained 500s tripped the per-endpoint circuit breaker open; wait out its
  // cooldown (~30s) so the replay's first attempt is a half-open trial that
  // succeeds, instead of fast-failing while the breaker is still open.
  await sleep(33000);
  const replay = await api('POST', `/deliveries/${bDid}/replay`, { key });
  assert(replay.status === 202, 'replay accepted', `replay status ${replay.status}`);
  assert(await pollDelivery(bDid, key, 'succeeded', 40000), 'replayed delivery succeeded', 'replayed delivery did not succeed');

  // Scenario D: 100x same idempotency_key -> exactly one event.
  console.log('[D] 100x one idempotency key -> one event');
  let eventId = null;
  let unique = true;
  for (let i = 0; i < 100; i++) {
    const r = await api('POST', '/events', {
      key,
      body: { type: 'c', payload: { i }, idempotency_key: 'chaos-dup' },
    });
    eventId ??= r.body.event_id;
    if (r.body.event_id !== eventId) unique = false;
  }
  assert(unique, '100 publishes collapsed to one event', 'idempotency key produced multiple events');
  // Scenario E: tampered body fails signature verification at the receiver.
  console.log('[E] tampered body fails verification');
  recreateChaos({ CHAOS_FORCE_STATUS: '200', CHAOS_SECRET: secret });
  await sleep(3000);
  const ts = Math.floor(Date.now() / 1000).toString();
  const goodBody = JSON.stringify({ ok: true });
  const goodSig = createHmac('sha256', secret).update(`${ts}.${goodBody}`).digest('hex');
  const good = await fetch(`${CHAOS}/hook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-webhook-id': 'manual',
      'x-webhook-timestamp': ts,
      'x-webhook-signature': `sha256=${goodSig}`,
    },
    body: goodBody,
  });
  assert(good.status === 200, 'valid signature accepted (200)', `valid sig got ${good.status}`);
  const tampered = await fetch(`${CHAOS}/hook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-webhook-id': 'manual',
      'x-webhook-timestamp': ts,
      'x-webhook-signature': `sha256=${goodSig}`,
    },
    body: JSON.stringify({ ok: false }), // body changed, signature no longer matches
  });
  assert(tampered.status === 401, 'tampered body rejected (401)', `tampered got ${tampered.status}`);
  // Restore the receiver to its default random chaos.
  recreateChaos({ CHAOS_FORCE_STATUS: '', CHAOS_SUCCEED_AFTER: '0', CHAOS_SECRET: '' });

  console.log(failures === 0 ? '\nALL CHAOS TESTS PASSED' : `\n${failures} CHAOS TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
