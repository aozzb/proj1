import { z } from 'zod';

export const createApplicationSchema = z.object({
  name: z.string().min(1).max(200),
});

export const createEndpointSchema = z.object({
  // Full SSRF validation (block localhost/private ranges) is CP4; here we only
  // enforce it's a syntactically valid http(s) URL.
  url: z.string().url().refine((u) => /^https?:\/\//.test(u), {
    message: 'url must be http(s)',
  }),
  event_types: z.array(z.string().min(1)).min(1),
  // Optional per-endpoint throttles; omit to use the service defaults.
  rate_limit_per_sec: z.number().int().positive().optional(),
  max_concurrency: z.number().int().positive().optional(),
});

export const publishEventSchema = z.object({
  type: z.string().min(1),
  payload: z.record(z.unknown()), // any JSON object
  idempotency_key: z.string().min(1).max(255).optional(),
});
