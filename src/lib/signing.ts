import { createHmac, timingSafeEqual } from 'crypto';

/**
 * HMAC-SHA256 request signing.
 *
 * We sign `${timestamp}.${rawBody}` (not just the body):
 *  - including the timestamp lets a receiver reject stale/replayed requests, and
 *  - binding the timestamp into the signature stops an attacker from changing it.
 *
 * The signature is sent as `X-Webhook-Signature: sha256=<hex>`, the event id as
 * `X-Webhook-Id`, and the unix-seconds timestamp as `X-Webhook-Timestamp`.
 */

export function signingString(timestamp: string, body: string): string {
  return `${timestamp}.${body}`;
}

/** Produce the hex HMAC-SHA256 signature for a request. */
export function sign(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(signingString(timestamp, body)).digest('hex');
}

export interface VerifyInput {
  secret: string;
  timestamp: string;
  body: string;
  /** The received signature, hex, with or without a leading "sha256=". */
  signature: string;
  /** Max allowed clock skew in seconds (replay protection). */
  toleranceSec?: number;
  /** Injectable clock for testing; unix seconds. */
  nowSec?: number;
}

/**
 * Verify a signature. Returns false (never throws) on any mismatch, so callers
 * can treat it as a plain boolean. Uses a constant-time comparison to avoid
 * leaking how much of the signature matched via timing.
 */
export function verify(input: VerifyInput): boolean {
  const { secret, timestamp, body, toleranceSec = 300 } = input;
  const received = input.signature.replace(/^sha256=/, '');
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);

  // Replay protection: reject timestamps outside the tolerance window.
  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > toleranceSec) {
    return false;
  }

  const expected = sign(secret, timestamp, body);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received, 'utf8');
  // timingSafeEqual requires equal lengths; unequal length is a definite mismatch.
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}
