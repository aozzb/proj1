// Shared helpers for CP7 load tests and failure experiments.
import os from 'node:os';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

export const API = process.env.API_URL || 'http://localhost:3000';
export const CHAOS = process.env.CHAOS_URL || 'http://localhost:4000';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minimal JSON HTTP helper against the API. */
export async function api(method, path, { key, body } = {}) {
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

/** Register an app + a subscribed endpoint; returns { key, secret, endpointId }. */
export async function setupAppEndpoint(eventType, { url } = {}) {
  const app = await api('POST', '/applications', { body: { name: `cp7-${Date.now()}` } });
  const key = app.body.api_key;
  const ep = await api('POST', '/endpoints', {
    key,
    body: { url: url || 'http://chaos-receiver:4000/hook', event_types: [eventType] },
  });
  return { key, secret: ep.body.secret, endpointId: ep.body.id };
}

/** Recreate the chaos receiver with the given CHAOS_* env (empty = reset). */
export function recreateChaos(env = {}) {
  execSync('docker compose up -d chaos-receiver', {
    env: {
      ...process.env,
      CHAOS_FORCE_STATUS: '',
      CHAOS_SUCCEED_AFTER: '0',
      CHAOS_SECRET: '',
      ...env,
    },
    stdio: 'ignore',
  });
}

export function compose(args, opts = {}) {
  return execSync(`docker compose ${args}`, { stdio: 'pipe', ...opts }).toString();
}

/** Scrape /metrics and return the count of deliveries in a given status. */
export async function succeededCount() {
  const res = await fetch(`${API}/metrics`);
  const text = await res.text();
  const m = text.match(/^webhook_deliveries\{status="succeeded"\}\s+(\d+)/m);
  return m ? Number(m[1]) : 0;
}

/** Poll until succeededCount reaches target or timeout; returns elapsed ms or throws. */
export async function waitForSucceeded(target, timeoutMs, label = 'drain') {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if ((await succeededCount()) >= target) return Date.now() - start;
    await sleep(200);
  }
  throw new Error(`waitForSucceeded(${label}) timed out: wanted ${target}, timeout ${timeoutMs}ms`);
}

/** Poll one delivery's status via the API until it matches, or throw. */
export async function waitDeliveryStatus(deliveryId, key, status, timeoutMs, label = status) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { body } = await api('GET', `/deliveries/${deliveryId}`, { key });
    if (body && body.status === status) return Date.now() - start;
    await sleep(500);
  }
  throw new Error(`waitDeliveryStatus(${label}) timed out after ${timeoutMs}ms`);
}

export async function deliveryIdForEvent(eventId, key, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { body } = await api('GET', '/deliveries', { key });
    const d = body?.deliveries?.find((x) => x.event_id === eventId);
    if (d) return d.id;
    await sleep(200);
  }
  throw new Error('deliveryIdForEvent: not found');
}

/** Environment/context block that every measured number must carry (metrics honesty). */
export function contextHeader(extra = {}) {
  const cpus = os.cpus();
  let docker = 'unknown';
  try {
    docker = execSync('docker --version').toString().trim();
  } catch {
    /* ignore */
  }
  return {
    timestamp: new Date().toISOString(),
    cpu: cpus[0]?.model?.trim(),
    logicalCores: cpus.length,
    ramGB: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
    os: `${os.platform()} ${os.release()}`,
    node: process.version,
    docker,
    receiver: 'in-container chaos receiver on localhost (NOT a real network)',
    ...extra,
  };
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}
