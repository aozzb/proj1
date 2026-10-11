import { createApp } from './app';
import { env } from './config/env';
import { logger } from './lib/logger';
import { closeDb } from './lib/db';
import { closeRedis } from './lib/redis';

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'API listening');
});

/**
 * Graceful shutdown: stop accepting new connections, let in-flight requests
 * finish, then release DB and Redis handles. A hard timeout guards against a
 * connection that never drains.
 */
async function shutdown(signal: string) {
  logger.info({ signal }, 'Shutting down');

  const forced = setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10_000);
  forced.unref();

  server.close(async () => {
    try {
      await Promise.allSettled([closeDb(), closeRedis()]);
      logger.info('Shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  });
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
