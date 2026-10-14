import express, { type ErrorRequestHandler } from 'express';
import pinoHttp from 'pino-http';
import { logger } from './lib/logger';
import { healthRouter } from './routes/health';
import { applicationsRouter } from './routes/applications';
import { endpointsRouter } from './routes/endpoints';
import { eventsRouter } from './routes/events';
import { deliveriesRouter } from './routes/deliveries';

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
  app.use(applicationsRouter);
  app.use(endpointsRouter);
  app.use(eventsRouter);
  app.use(deliveriesRouter);

  // Centralized error handler: log the real error, return a generic message.
  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    logger.error({ err }, 'unhandled request error');
    res.status(500).json({ error: 'internal server error' });
  };
  app.use(errorHandler);

  return app;
}
