import { describe, it, expect } from 'vitest';
import { isPrivateIp, assertUrlAllowed, SsrfBlockedError } from '../../src/lib/ssrf';

describe('isPrivateIp', () => {
  it('flags loopback / private / link-local / reserved', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '100.64.0.1', // CGNAT
      '0.0.0.0',
      '224.0.0.1', // multicast
      '::1',
      'fe80::1',
      'fc00::1',
      '::ffff:10.0.0.1', // v4-mapped private
    ]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });

  it('allows public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111']) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });
});

describe('assertUrlAllowed', () => {
  // Note: the test env sets SSRF_ALLOW_PRIVATE=true, so IP-range checks are
  // bypassed. The protocol/credential checks run regardless of that flag.
  it('rejects non-http(s) protocols', async () => {
    await expect(assertUrlAllowed('ftp://example.com/x')).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(assertUrlAllowed('file:///etc/passwd')).rejects.toBeInstanceOf(SsrfBlockedError);
  });
  it('rejects embedded credentials', async () => {
    await expect(assertUrlAllowed('http://user:pass@example.com/x')).rejects.toBeInstanceOf(
      SsrfBlockedError
    );
  });
  it('rejects a malformed URL', async () => {
    await expect(assertUrlAllowed('not a url')).rejects.toBeInstanceOf(SsrfBlockedError);
  });
  it('allows a normal http URL', async () => {
    await expect(assertUrlAllowed('http://example.com/hook')).resolves.toBeUndefined();
  });
});
