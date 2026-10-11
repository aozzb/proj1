import type { RequestHandler } from 'express';
import { pool } from '../lib/db';
import { hashApiKey } from '../lib/crypto';

export interface AppContext {
  id: string;
  name: string;
}

// Attach the authenticated application to the request for downstream handlers.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      application?: AppContext;
    }
  }
}

/**
 * Bearer-token auth. The client sends the raw API key; we hash it and look up
 * the matching application. We never store or compare the raw key.
 */
export const apiKeyAuth: RequestHandler = async (req, res, next) => {
  try {
    const header = req.header('authorization');
    if (!header || !header.startsWith('Bearer ')) {
      res.status(401).json({ error: 'missing or malformed Authorization header' });
      return;
    }

    const key = header.slice('Bearer '.length).trim();
    const hash = hashApiKey(key);

    const { rows } = await pool.query<AppContext>(
      'SELECT id, name FROM applications WHERE api_key_hash = $1',
      [hash]
    );

    if (rows.length === 0) {
      res.status(401).json({ error: 'invalid API key' });
      return;
    }

    req.application = rows[0];
    next();
  } catch (err) {
    next(err);
  }
};
