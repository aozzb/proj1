import { randomBytes, createHash } from 'crypto';

/**
 * API keys and endpoint HMAC secrets are high-entropy random tokens.
 *
 * Because they are random (not human-chosen), a fast hash (SHA-256) is the right
 * choice for storage: there is nothing to brute-force, and we get an O(1) exact
 * lookup by hash. Slow password hashes (bcrypt/argon2) exist to slow down
 * guessing of low-entropy human passwords — not applicable here.
 */

/** A customer-facing API key. Shown once at creation; only its hash is stored. */
export function generateApiKey(): string {
  return `whsk_${randomBytes(32).toString('hex')}`;
}

/** The per-endpoint secret used later (CP3) to HMAC-sign outgoing requests. */
export function generateSecret(): string {
  return `whsec_${randomBytes(32).toString('hex')}`;
}

/** Deterministic hash used to store/look up an API key. */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}
