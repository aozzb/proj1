#!/usr/bin/env node
// CP7 failure experiments. Each runs against the live compose stack, writes a
// raw timestamped log to docs/experiments/, and prints PASS/FAIL. Honest by
// construction: it reports what actually happens, including recovery latency.
//
// Usage: docker compose up -d && node scripts/experiments/run.mjs
import { writeFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import {
  api,
  CHAOS,
  setupAppEndpoint,
  recreateChaos,
  compose,
  sleep,
  succeededCount,
  waitForSucceeded,
  waitDeliveryStatus,
  deliveryIdForEvent,
  contextHeader,
  ensureDir,
} from '../lib/util.mjs';

ensureDir('docs/experiments');
let failures = 0;

function makeLogger(name) {
  const lines = [];
  const log = (m) => {
    const line = `[${new Date().toISOString()}] ${m}`;
    lines.push(line);
    console.log('   ' + line);
  };
  const save = () => writeFileSync(`docs/experiments/${name}.txt`, lines.join('\n') + '\n');
  return { log, save };
}
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => {
  console.log(`  FAIL  ${m}`);
  failures++;
};
const redisKeys = () =>
  compose('exec -T redis redis-cli KEYS "bull:deliveries:*"')
    .split('\n')
    .filter((l) => l.trim()).length;

async function expWorkerKill() {
  const name = 'worker-kill-mid-delivery';
  console.log(`\n[1] ${name}`);
  const { log, save } = makeLogger(name);
  log(JSON.stringify(contextHeader({ experiment: name })));
  recreateChaos({ CHAOS_FORCE_STATUS: 'hang' });
  await sleep(2500);
  const { key } = await setupAppEndpoint('wk');
  const ev = await api('POST', '/events', { key, body: { type: 'wk', payload: {} } });
  const did = await deliveryIdForEvent(ev.body.event_id, key);
  log(`published event ${ev.body.event_id}, delivery ${did}; receiver is hanging`);
  await sleep(2000);
  log('killing worker mid-delivery (docker compose kill worker)');
  compose('kill worker');
  await sleep(1000);
  log('switching receiver to 200 and restarting worker');
  recreateChaos({ CHAOS_FORCE_STATUS: '200' });
  compose('start worker');
  try {
    // Recovery is via BullMQ's stalled-job reclaim (~30s interval): the killed
    // worker's locked job is detected as stalled and re-run by the new worker.
    // So allow a realistic window rather than expecting instant recovery.
    const ms = await waitDeliveryStatus(did, key, 'succeeded', 120000);
    log(`delivery recovered and succeeded after ${ms}ms via stalled-job reclaim (no event lost)`);
    pass(`${name}: delivery survived worker kill and eventually succeeded`);
  } catch (e) {
    log(`FAILED: ${e.message}`);
    fail(`${name}: ${e.message}`);
  }
  save();
}

async function exp500WithinBudget() {
  const name = 'receiver-transient-failures-auto-recover';
  console.log(`\n[2a] ${name}`);
  const { log, save } = makeLogger(name);
  log(
    JSON.stringify(
      contextHeader({
        experiment: name,
        note: 'receiver fails 2x then succeeds (2 < breaker threshold 5), so retries alone recover it with no intervention',
      })
    )
  );
  recreateChaos({ CHAOS_SUCCEED_AFTER: '2' });
  await sleep(2500);
  const { key } = await setupAppEndpoint('r5a');
  const ev = await api('POST', '/events', { key, body: { type: 'r5a', payload: {} } });
  const did = await deliveryIdForEvent(ev.body.event_id, key);
  log(`published ${did}; receiver will fail attempts 1-2 then return 200`);
  try {
    const ms = await waitDeliveryStatus(did, key, 'succeeded', 40000);
    log(`delivered after ${ms}ms via automatic retries (no operator action)`);
    pass(`${name}: transient failures auto-recovered`);
  } catch (e) {
    log(`FAILED: ${e.message}`);
    fail(`${name}: ${e.message}`);
  }
  save();
}

async function exp500ToDlqReplay() {
  const name = 'receiver-500-exhaust-to-dlq-then-replay';
  console.log(`\n[2b] ${name}`);
  const { log, save } = makeLogger(name);
  log(JSON.stringify(contextHeader({ experiment: name, note: 'default 6 attempts reach DLQ in a few minutes, NOT 10 min' })));
  recreateChaos({ CHAOS_FORCE_STATUS: '500' });
  await sleep(2500);
  const { key } = await setupAppEndpoint('r5b');
  const ev = await api('POST', '/events', { key, body: { type: 'r5b', payload: {} } });
  const did = await deliveryIdForEvent(ev.body.event_id, key);
  log(`published ${did}; receiver permanently 500`);
  try {
    const deadMs = await waitDeliveryStatus(did, key, 'dead', 120000);
    log(`delivery exhausted retries and landed in DLQ after ${deadMs}ms`);
    recreateChaos({ CHAOS_FORCE_STATUS: '200' });
    // The sustained 500s also tripped the per-endpoint circuit breaker open.
    // Replaying while it is open would just fast-fail until the cooldown; wait
    // it out (default CB_OPEN_MS=30s) so the replay's first attempt is a
    // half-open trial that succeeds. This is the real, honest interplay.
    log('receiver fixed; waiting out circuit-breaker cooldown (~30s) before replay');
    await sleep(33000);
    log('replaying the dead delivery');
    await api('POST', `/deliveries/${did}/replay`, { key });
    const ms = await waitDeliveryStatus(did, key, 'succeeded', 40000);
    log(`replayed delivery succeeded after ${ms}ms`);
    pass(`${name}: DLQ then replay recovered it (after breaker cooldown)`);
  } catch (e) {
    log(`FAILED: ${e.message}`);
    fail(`${name}: ${e.message}`);
  }
  save();
}

async function expHang() {
  const name = 'receiver-hang-timeout';
  console.log(`\n[3] ${name}`);
  const { log, save } = makeLogger(name);
  log(JSON.stringify(contextHeader({ experiment: name })));
  recreateChaos({ CHAOS_FORCE_STATUS: 'hang' });
  await sleep(2500);
  const { key } = await setupAppEndpoint('hg');
  const ev = await api('POST', '/events', { key, body: { type: 'hg', payload: {} } });
  const did = await deliveryIdForEvent(ev.body.event_id, key);
  log(`published ${did}; receiver hangs (worker timeout should fire ~8s)`);
  await sleep(12000);
  const { body } = await api('GET', `/deliveries/${did}`, { key });
  const timedOut = (body.attempts || []).find((a) => a.status_code === null && /timeout/i.test(a.error || ''));
  if (timedOut) {
    log(`attempt timed out: ${timedOut.latency_ms}ms, error="${timedOut.error}" (worker not blocked)`);
    pass(`${name}: hanging receiver timed out and was retried`);
  } else {
    log(`FAILED: no timeout attempt recorded; attempts=${JSON.stringify(body.attempts)}`);
    fail(`${name}: no timeout recorded`);
  }
  save();
}

async function expRedisLoss() {
  const name = 'redis-loss-recovery';
  console.log(`\n[4] ${name}`);
  const { log, save } = makeLogger(name);
  log(JSON.stringify(contextHeader({ experiment: name })));
  recreateChaos({ CHAOS_FORCE_STATUS: '200' });
  await sleep(2000);
  log('stopping worker so jobs queue up');
  compose('stop worker');
  const { key } = await setupAppEndpoint('rl');
  const baseline = await succeededCount();
  const M = 20;
  for (let i = 0; i < M; i++) await api('POST', '/events', { key, body: { type: 'rl', payload: { i } } });
  const before = redisKeys();
  log(`published ${M} events; redis bull:deliveries keys now = ${before}`);
  log('simulating Redis data loss: FLUSHALL');
  compose('exec -T redis redis-cli FLUSHALL');
  const after = redisKeys();
  log(`redis keys after FLUSHALL = ${after} (Postgres still holds the pending deliveries)`);
  log('starting worker; the scheduler sweeper should re-enqueue from Postgres');
  compose('start worker');
  try {
    const ms = await waitForSucceeded(baseline + M, 90000, name);
    log(`all ${M} deliveries recovered from Postgres and delivered after ${ms}ms`);
    pass(`${name}: Redis loss recovered via the reconciling sweeper`);
  } catch (e) {
    log(`FAILED: ${e.message}`);
    fail(`${name}: ${e.message}`);
  }
  save();
}

async function expIdempotency() {
  const name = 'idempotency-100x';
  console.log(`\n[5] ${name}`);
  const { log, save } = makeLogger(name);
  log(JSON.stringify(contextHeader({ experiment: name })));
  recreateChaos({ CHAOS_FORCE_STATUS: '200' });
  await sleep(1500);
  const { key } = await setupAppEndpoint('idem');
  let eventId = null;
  let allSame = true;
  for (let i = 0; i < 100; i++) {
    const r = await api('POST', '/events', { key, body: { type: 'idem', payload: { i }, idempotency_key: 'exp-key' } });
    eventId ??= r.body.event_id;
    if (r.body.event_id !== eventId) allSame = false;
  }
  log(`100 publishes with one idempotency_key -> event_id ${eventId}, all identical=${allSame}`);
  if (allSame) pass(`${name}: 100 publishes collapsed to one event`);
  else fail(`${name}: produced multiple events`);
  save();
}

async function expTamper() {
  const name = 'tamper-rejected';
  console.log(`\n[6] ${name}`);
  const { log, save } = makeLogger(name);
  log(JSON.stringify(contextHeader({ experiment: name })));
  const { secret } = await setupAppEndpoint('tmp');
  recreateChaos({ CHAOS_FORCE_STATUS: '200', CHAOS_SECRET: secret });
  await sleep(2500);
  const ts = Math.floor(Date.now() / 1000).toString();
  const good = JSON.stringify({ ok: true });
  const sig = createHmac('sha256', secret).update(`${ts}.${good}`).digest('hex');
  const hdr = (body) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-webhook-id': 'x', 'x-webhook-timestamp': ts, 'x-webhook-signature': `sha256=${sig}` },
    body,
  });
  const okRes = await fetch(`${CHAOS}/hook`, hdr(good));
  const badRes = await fetch(`${CHAOS}/hook`, hdr(JSON.stringify({ ok: false })));
  log(`valid signature -> ${okRes.status}; tampered body -> ${badRes.status}`);
  if (okRes.status === 200 && badRes.status === 401) pass(`${name}: valid accepted, tampered rejected (401)`);
  else fail(`${name}: unexpected statuses ${okRes.status}/${badRes.status}`);
  save();
}

async function main() {
  console.log('== CP7 failure experiments ==');
  await expWorkerKill();
  await exp500WithinBudget();
  await exp500ToDlqReplay();
  await expHang();
  await expRedisLoss();
  await expIdempotency();
  await expTamper();
  recreateChaos(); // restore default random chaos
  console.log(failures === 0 ? '\nALL EXPERIMENTS PASSED' : `\n${failures} EXPERIMENT(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
