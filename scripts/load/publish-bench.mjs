#!/usr/bin/env node
// Publish-throughput benchmark: how many POST /events the API accepts per second
// (auth -> insert event -> fan-out -> enqueue). Measures the API, not delivery.
//
// Usage: docker compose up -d && node scripts/load/publish-bench.mjs
import autocannon from 'autocannon';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { API, setupAppEndpoint, recreateChaos, sleep, contextHeader, ensureDir } from '../lib/util.mjs';

const require = createRequire(import.meta.url);
const CONNECTIONS = Number(process.env.CONNECTIONS || 20);
const DURATION = Number(process.env.DURATION || 10);

async function main() {
  // Receiver always-200, no signature verification, so the worker can drain in
  // the background without becoming the bottleneck for this API measurement.
  recreateChaos({ CHAOS_FORCE_STATUS: '200' });
  await sleep(2000);

  const { key } = await setupAppEndpoint('bench');

  const header = contextHeader({
    tool: `autocannon@${require('autocannon/package.json').version}`,
    scenario: 'POST /events (publish throughput)',
    connections: CONNECTIONS,
    durationSec: DURATION,
    workerConcurrencyEnv: process.env.WORKER_CONCURRENCY || '10 (default)',
  });
  console.log('context:', JSON.stringify(header, null, 2));

  const result = await autocannon({
    url: `${API}/events`,
    connections: CONNECTIONS,
    duration: DURATION,
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ type: 'bench', payload: { k: 1 } }),
  });

  const summary = {
    context: header,
    requestsPerSec: { mean: result.requests.mean, stddev: result.requests.stddev },
    latencyMs: {
      p50: result.latency.p50,
      p97_5: result.latency.p97_5,
      p99: result.latency.p99,
      max: result.latency.max,
    },
    total2xx: result['2xx'],
    totalNon2xx: result.non2xx,
    throughputBytesPerSec: result.throughput.mean,
  };

  ensureDir('docs/benchmarks');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = `docs/benchmarks/publish-${stamp}.json`;
  writeFileSync(file, JSON.stringify(summary, null, 2));
  console.log('\n=== PUBLISH THROUGHPUT ===');
  console.log(`req/sec (mean): ${summary.requestsPerSec.mean}`);
  console.log(`latency p50/p99 ms: ${summary.latencyMs.p50} / ${summary.latencyMs.p99}`);
  console.log(`2xx: ${summary.total2xx}  non-2xx: ${summary.totalNon2xx}`);
  console.log(`raw saved: ${file}`);

  recreateChaos();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
