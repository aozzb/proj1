import { describe, it, expect } from 'vitest';
import { sign, verify } from '../../src/lib/signing';

const secret = 'whsec_test_secret';
const now = 1_700_000_000;
const body = JSON.stringify({ hello: 'world' });

describe('signing', () => {
  it('produces a stable signature for the same inputs', () => {
    const a = sign(secret, String(now), body);
    const b = sign(secret, String(now), body);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('verifies a valid signature (with or without sha256= prefix)', () => {
    const sig = sign(secret, String(now), body);
    expect(verify({ secret, timestamp: String(now), body, signature: sig, nowSec: now })).toBe(true);
    expect(
      verify({ secret, timestamp: String(now), body, signature: `sha256=${sig}`, nowSec: now })
    ).toBe(true);
  });

  it('rejects a tampered body', () => {
    const sig = sign(secret, String(now), body);
    expect(
      verify({ secret, timestamp: String(now), body: body + 'x', signature: sig, nowSec: now })
    ).toBe(false);
  });

  it('rejects a wrong secret', () => {
    const sig = sign(secret, String(now), body);
    expect(
      verify({ secret: 'other', timestamp: String(now), body, signature: sig, nowSec: now })
    ).toBe(false);
  });

  it('rejects a stale timestamp (replay protection)', () => {
    const staleTs = now - 10_000;
    const sig = sign(secret, String(staleTs), body);
    expect(
      verify({ secret, timestamp: String(staleTs), body, signature: sig, nowSec: now, toleranceSec: 300 })
    ).toBe(false);
  });

  it('rejects a malformed signature without throwing', () => {
    expect(verify({ secret, timestamp: String(now), body, signature: 'nothex', nowSec: now })).toBe(
      false
    );
  });
});
