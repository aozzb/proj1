import express from 'express';
import { verify } from '../lib/signing';

/**
 * A deliberately unreliable webhook receiver for CP3 testing.
 *
 * It randomly succeeds, fails with a 500, or hangs past the worker's timeout —
 * real failure modes, not mocked away. It also verifies the HMAC signature when
 * a secret is configured, so we can prove signing works end to end.
 *
 * This process is intentionally standalone (no src/config/env import) so it does
 * not need the app's DATABASE_URL/REDIS_URL. It reads its own env directly.
 */
const PORT = Number(process.env.CHAOS_PORT ?? 4000);
const FAIL_RATE = Number(process.env.CHAOS_FAIL_RATE ?? 0.4); // P(500)
const HANG_RATE = Number(process.env.CHAOS_HANG_RATE ?? 0.2); // P(hang), after fail roll
const HANG_MS = Number(process.env.CHAOS_HANG_MS ?? 20_000);
// Deterministic override for testing: "200" | "400" | "500" | "hang" (forces
// every request). Empty = random chaos per the rates above.
const FORCE = process.env.CHAOS_FORCE_STATUS ?? '';
// Deterministic retry test: fail the first N attempts of a given webhook id with
// a 500, then succeed. 0 = disabled.
const SUCCEED_AFTER = Number(process.env.CHAOS_SUCCEED_AFTER ?? 0);
const SECRET = process.env.CHAOS_SECRET ?? '';

// Per-webhook-id attempt counter (in-memory) for SUCCEED_AFTER.
const seen = new Map<string, number>();
const TOLERANCE = Number(process.env.SIGNATURE_TOLERANCE_SEC ?? 300);

const app = express();
// Capture the raw body exactly as sent so the signature check is byte-accurate.
app.use(express.raw({ type: '*/*', limit: '1mb' }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

app.post('/hook', async (req, res) => {
  const body = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  const id = req.header('x-webhook-id') ?? '';
  const timestamp = req.header('x-webhook-timestamp') ?? '';
  const signature = req.header('x-webhook-signature') ?? '';

  let sigStatus: string;
  if (!SECRET) {
    sigStatus = 'not-verified(no-secret)';
  } else {
    sigStatus = verify({ secret: SECRET, timestamp, body, signature, toleranceSec: TOLERANCE })
      ? 'valid'
      : 'INVALID';
  }
  console.log(`[chaos] recv id=${id} ts=${timestamp} sig=${sigStatus} body=${body}`);

  if (SECRET && sigStatus !== 'valid') {
    res.status(401).json({ error: 'bad signature' });
    return;
  }

  // Deterministic "fail N times then succeed" for retry testing.
  if (SUCCEED_AFTER > 0) {
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    if (n <= SUCCEED_AFTER) {
      return void res.status(500).json({ error: `chaos 500 (attempt ${n})` });
    }
    return void res.status(200).json({ ok: true, attempt: n });
  }

  // Deterministic override via env (applies to every request).
  if (FORCE) {
    if (FORCE === 'hang') {
      await sleep(HANG_MS);
      return void res.status(200).json({ ok: true, late: true });
    }
    return void res.status(Number(FORCE)).json({ forced: Number(FORCE) });
  }

  // Deterministic override per-request via header: x-chaos-mode = ok|fail|hang|reject
  const mode = req.header('x-chaos-mode');
  if (mode === 'ok') return void res.status(200).json({ ok: true });
  if (mode === 'fail') return void res.status(500).json({ error: 'forced fail' });
  if (mode === 'reject') return void res.status(400).json({ error: 'forced reject' });
  if (mode === 'hang') {
    await sleep(HANG_MS);
    return void res.status(200).json({ ok: true, late: true });
  }

  // Random chaos.
  const roll = Math.random();
  if (roll < FAIL_RATE) {
    res.status(500).json({ error: 'chaos 500' });
  } else if (roll < FAIL_RATE + HANG_RATE) {
    await sleep(HANG_MS);
    res.status(200).json({ ok: true, late: true });
  } else {
    res.status(200).json({ ok: true });
  }
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`[chaos] receiver listening on ${PORT} (verify=${SECRET ? 'on' : 'off'})`);
});
