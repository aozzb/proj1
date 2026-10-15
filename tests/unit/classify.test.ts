import { describe, it, expect } from 'vitest';
import { isRetryableStatus } from '../../src/worker/classify';

describe('isRetryableStatus', () => {
  it('retries 5xx', () => {
    for (const s of [500, 502, 503, 504]) expect(isRetryableStatus(s)).toBe(true);
  });
  it('retries the transient 4xx (408, 429)', () => {
    expect(isRetryableStatus(408)).toBe(true);
    expect(isRetryableStatus(429)).toBe(true);
  });
  it('does NOT retry other 4xx', () => {
    for (const s of [400, 401, 403, 404, 410, 422]) expect(isRetryableStatus(s)).toBe(false);
  });
  it('does NOT retry 2xx/3xx', () => {
    for (const s of [200, 201, 204, 301, 302]) expect(isRetryableStatus(s)).toBe(false);
  });
});
