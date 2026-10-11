import express from 'express';
import pinoHttp from 'pino-http';
import { logger } from './lib/logger';
import { healthRouter } from './routes/health';

/**
 * Builds the Express app. Kept separate from server startup so tests can import
 * the app without binding a port.
 */
export function createApp() {
  const app = express();

  // Request logging with the shared (redacting) logger.
  app.use(pinoHttp({ logger }));
  app.use(express.json());

  app.use(healthRouter);

  return app;
}
