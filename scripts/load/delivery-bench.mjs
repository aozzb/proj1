#!/usr/bin/env node
// End-to-end delivery-throughput benchmark: publish M events to an always-200
// in-container receiver, then measure wall-clock until all M are delivered
// (succeeded), using the /metrics succeeded gauge. Reports deliveries/sec.
//
// Run twice with different WORKER_CONCURRENCY for a before/after comparison.
// Usage: MESSAGES=300 node scripts/load/delivery-bench.mjs
import { writeFileSync } from 'node:fs';
import {
  api,
  setupAppEndpoint,
  recreateChaos,
  sleep,
  succeededCount,
  waitForSucceeded,
  contextHeader,
  ensureDir,
} from '../lib/util.mjs';

const MESSAGES = Number(process.env.MESSAGES || 300);
const PUBLISH_CONCURRENCY = Number(process.env.PUBLISH_CONCURRENCY || 50);

async function publishAll(key) {
  let next = 0;
  async function worker() {
    while (next < MESSAGES) {
      const i = next++;
      await api('POST', '/events', { key, body: { type: 'bench', payload: { i } } });
    }
  }
  await Promise.all(Array.from({ length: PUBLISH_CONCURRENCY }, worker));
}

async function main() {
  recreateChaos({ CHAOS_FORCE_STATUS: '200' });
  await sleep(2000);
  const { key } = await setupAppEndpoint('bench');

  const baseline = await succeededCount();
  const target = baseline + MESSAGES;

  const header = contextHeader({
    scenario: 'end-to-end delivery throughput',
    messages: MESSAGES,
    publishConcurrency: PUBLISH_CONCURRENCY,
    workerConcurrencyEnv: process.env.WORKER_CONCURRENCY || '10 (default)',
    note: 'receiver forced 200, signature verification OFF for raw throughput',
  });
  console.log('context:', JSON.stringify(header, null, 2));

  const t0 = Date.now();
  await publishAll(key);
  const publishMs = Date.now() - t0;

  const drainMs = await waitForSucceeded(target, 120000, 'delivery-bench');
  const totalMs = Date.now() - t0;

  const summary = {
    context: header,
    publishMs,
    publishPerSec: Math.round((MESSAGES / publishMs) * 1000),
    totalWallMs: totalMs,
    drainWaitMs: drainMs,
    deliveriesPerSec: Math.round((MESSAGES / totalMs) * 1000),
  };

  ensureDir('docs/benchmarks');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const wc = process.env.WORKER_CONCURRENCY || 'default';
  const file = `docs/benchmarks/delivery-wc${wc}-${stamp}.json`;
  writeFileSync(file, JSON.stringify(summary, null, 2));
  console.log('\n=== DELIVERY THROUGHPUT ===');
  console.log(`messages: ${MESSAGES}  worker_concurrency: ${wc}`);
  console.log(`publish: ${publishMs}ms (${summary.publishPerSec}/s)`);
  console.log(`end-to-end: ${totalMs}ms => ${summary.deliveriesPerSec} deliveries/sec`);
  console.log(`raw saved: ${file}`);

  recreateChaos();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
