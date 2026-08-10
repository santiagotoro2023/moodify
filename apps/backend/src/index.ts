import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyError } from 'fastify';
import { ZodError } from 'zod';
import { ASSETS_DIR, SPA_DIR } from './config.ts';
import { assertEncryptionKey } from './crypto.ts';
import { migrate, sql, waitForDatabase } from './db.ts';
import { registerRoutes } from './routes/index.ts';
import { startSyncScheduler } from './sync.ts';

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  bodyLimit: 12 * 1024 * 1024,
});

// Zod failures are user input problems, not 500s.
app.setErrorHandler((error: FastifyError, _request, reply) => {
  if (error instanceof ZodError) {
    return reply.code(400).send({
      error: 'Invalid input',
      details: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  app.log.error(error);
  const status = error.statusCode ?? 500;
  return reply.code(status).send({ error: status === 500 ? 'Internal error' : error.message });
});

async function main() {
  assertEncryptionKey();

  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('SESSION_SECRET must be set and at least 32 characters. See .env.');
  }

  await mkdir(join(ASSETS_DIR, 'badges'), { recursive: true });
  await mkdir(join(ASSETS_DIR, 'uploads'), { recursive: true });

  await app.register(cookie, { secret });
  await app.register(multipart, { limits: { fileSize: 8 * 1024 * 1024, files: 1 } });

  app.get('/api/health', async (_request, reply) => {
    try {
      await sql('select 1');
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false, error: 'database unavailable' });
    }
  });

  await registerRoutes(app);

  // Cached badge images and uploaded logos/backgrounds, served by Moodify itself
  // rather than hotlinked from Moodle's authenticated pluginfile.php (§9.3).
  await app.register(fastifyStatic, {
    root: ASSETS_DIR,
    prefix: '/assets-store/',
    decorateReply: false,
  });

  await app.register(fastifyStatic, { root: SPA_DIR, prefix: '/' });

  // SPA fallback: any non-API path renders the app, which routes client-side.
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'Not found' });
    }
    return reply.sendFile('index.html');
  });

  await waitForDatabase();
  await migrate();

  const port = Number(process.env.PORT ?? 8080);
  await app.listen({ port, host: '0.0.0.0' });
  app.log.info(`Moodify listening on ${port}`);

  startSyncScheduler(app.log);
}

main().catch((err) => {
  app.log.error(err);
  process.exit(1);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    app.close().then(() => process.exit(0));
  });
}
