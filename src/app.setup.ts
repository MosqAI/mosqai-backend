import type { INestApplication } from '@nestjs/common';
import type { Env } from './config/env.js';

/** Shared by main and e2e tests so both get the same prefix, CORS and shutdown behaviour. */
export function configureApp(app: INestApplication, env: Env) {
  app.setGlobalPrefix('v1', { exclude: ['health'] });
  app.enableCors({ origin: env.CORS_ORIGINS.split(',').map((o) => o.trim()) });
  app.enableShutdownHooks();
  return app;
}
