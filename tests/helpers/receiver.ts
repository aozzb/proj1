import { createServer, type Server } from 'http';
import { verify } from '../../src/lib/signing';

export type ReceiverMode = 'ok' | '500' | '400' | 'hang' | 'succeed-after';

export interface ReceivedRequest {
  id: string;
  sigValid: boolean | null;
  body: string;
}

export interface TestReceiver {
  url: string;
  received: ReceivedRequest[];
  setMode: (mode: ReceiverMode, succeedAfter?: number) => void;
  setSecret: (secret: string) => void;
  reset: () => void;
  close: () => Promise<void>;
}

/**
 * A controllable local webhook receiver for the in-process worker to POST to.
 * It verifies the HMAC signature when a secret is set, so tests can assert the
 * delivery was correctly signed end to end.
 */
export async function startReceiver(): Promise<TestReceiver> {
  let mode: ReceiverMode = 'ok';
  let succeedAfter = 0;
  let secret = '';
  const counts = new Map<string, number>();
  const received: ReceivedRequest[] = [];

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const id = (req.headers['x-webhook-id'] as string) || '';
      const ts = (req.headers['x-webhook-timestamp'] as string) || '';
      const sig = (req.headers['x-webhook-signature'] as string) || '';
      const sigValid = secret ? verify({ secret, timestamp: ts, body, signature: sig }) : null;
      received.push({ id, sigValid, body });

      if (secret && sigValid === false) {
        res.statusCode = 401;
        res.end('bad signature');
        return;
      }
      if (mode === 'succeed-after') {
        const n = (counts.get(id) ?? 0) + 1;
        counts.set(id, n);
        res.statusCode = n <= succeedAfter ? 500 : 200;
        res.end(n <= succeedAfter ? 'fail' : 'ok');
        return;
      }
      if (mode === '500') {
        res.statusCode = 500;
        res.end('err');
        return;
      }
      if (mode === '400') {
        res.statusCode = 400;
        res.end('bad request');
        return;
      }
      if (mode === 'hang') {
        // Respond well after the worker's timeout so the delivery times out.
        setTimeout(() => {
          try {
            res.end('late');
          } catch {
            /* socket already closed by the aborted client */
          }
        }, 5000);
        return;
      }
      res.statusCode = 200;
      res.end('ok');
    });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  return {
    url: `http://127.0.0.1:${port}/hook`,
    received,
    setMode(m, n = 0) {
      mode = m;
      succeedAfter = n;
    },
    setSecret(s) {
      secret = s;
    },
    reset() {
      mode = 'ok';
      succeedAfter = 0;
      counts.clear();
      received.length = 0;
    },
    close() {
      return new Promise<void>((r) => server.close(() => r()));
    },
  };
}
