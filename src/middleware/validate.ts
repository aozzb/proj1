import type { RequestHandler } from 'express';
import type { ZodTypeAny } from 'zod';

/**
 * Validate (and narrow) the request body against a zod schema. On failure,
 * respond 400 with the field-level errors. On success, replace req.body with
 * the parsed value so handlers get typed, trusted data.
 */
export const validateBody =
  (schema: ZodTypeAny): RequestHandler =>
  (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({ error: 'validation failed', details: result.error.flatten() });
      return;
    }
    req.body = result.data;
    next();
  };
