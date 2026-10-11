import type { RequestHandler } from 'express';

/**
 * Express 4 does not catch rejected promises from async route handlers, so an
 * unhandled rejection would hang the request. This wrapper forwards any thrown
 * error to the error-handling middleware via next(err).
 */
export const asyncHandler =
  (fn: RequestHandler): RequestHandler =>
  (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);
