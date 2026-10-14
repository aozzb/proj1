import { lookup } from 'dns/promises';
import { isIP } from 'net';
import { env } from '../config/env';

/**
 * SSRF protection for customer-supplied endpoint URLs.
 *
 * We validate at endpoint creation AND again in the worker just before the POST,
 * because DNS can rebind (a host that resolved to a public IP at creation can
 * later resolve to a private one). Set SSRF_ALLOW_PRIVATE=true in local/dev only
 * so the in-cluster chaos receiver (a private IP) stays reachable.
 */
export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

/** Is this literal IP address in a loopback / private / link-local / reserved range? */
export function isPrivateIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isPrivateIpv4(ip);
  if (v === 6) return isPrivateIpv6(ip);
  return true; // not a parseable IP -> treat as unsafe
}

function isPrivateIpv4(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (incl. cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240/4 reserved
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const addr = ip.toLowerCase();
  if (addr === '::1' || addr === '::') return true; // loopback / unspecified
  if (addr.startsWith('fe80')) return true; // link-local fe80::/10
  if (addr.startsWith('fc') || addr.startsWith('fd')) return true; // unique-local fc00::/7
  // IPv4-mapped (::ffff:a.b.c.d) -> validate the embedded v4.
  const mapped = addr.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIpv4(mapped[1]);
  return false;
}

/**
 * Throws SsrfBlockedError if the URL is not a safe http(s) target.
 * Checks protocol + embedded credentials always; checks resolved IPs unless
 * SSRF_ALLOW_PRIVATE is enabled.
 */
export async function assertUrlAllowed(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError('invalid URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfBlockedError('only http(s) URLs are allowed');
  }
  if (url.username || url.password) {
    throw new SsrfBlockedError('credentials in URL are not allowed');
  }

  if (env.SSRF_ALLOW_PRIVATE) return;

  const host = url.hostname;
  // If the host is a literal IP, check it directly; otherwise resolve all of them.
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new SsrfBlockedError(`blocked private address: ${host}`);
    return;
  }

  let addrs: { address: string }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new SsrfBlockedError(`could not resolve host: ${host}`);
  }
  if (addrs.length === 0) throw new SsrfBlockedError(`host did not resolve: ${host}`);
  for (const { address } of addrs) {
    if (isPrivateIp(address)) {
      throw new SsrfBlockedError(`host ${host} resolves to a blocked address: ${address}`);
    }
  }
}
