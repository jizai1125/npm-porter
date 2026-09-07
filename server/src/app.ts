import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import type { AppConfig } from './config.js';
import { AuthService } from './auth.js';
import { registerApiRoutes } from './routes/api.js';
import { registerAuthGuard, registerAuthRoutes } from './routes/auth.js';

export async function buildApp(config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  const auth = new AuthService(config);

  await app.register(cors, { origin: true, credentials: true });
  await app.register(cookie, { secret: config.auth.sessionSecret });
  await app.register(multipart, {
    limits: {
      fileSize: config.maxUploadMb * 1024 * 1024,
      files: 1
    }
  });
  registerAuthGuard(app, auth);
  await registerAuthRoutes(app, auth);
  await registerApiRoutes(app, config);

  return app;
}
