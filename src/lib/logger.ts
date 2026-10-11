import pino from 'pino';
import { env } from '../config/env';

/**
 * One shared logger. The redaction list is set up now, before we have any
 * secrets to leak, so that as the service grows (API keys, HMAC secrets,
 * Authorization headers) they are stripped from logs by default rather than
 * remembered case by case. Engineering rule: never log secrets.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-api-key"]',
      'req.headers.cookie',
      '*.secret',
      '*.apiKey',
      '*.api_key',
      '*.password',
      'password',
      'secret',
    ],
    censor: '[redacted]',
  },
  // Pretty output only in dev; JSON everywhere else so log shippers can parse it.
  transport:
    env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
      : undefined,
});
