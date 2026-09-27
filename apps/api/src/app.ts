import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { hasZodFastifySchemaValidationErrors, jsonSchemaTransform, serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { API_PREFIX } from '@ksp/shared';
import { createDb, loadConfig, logger, Storage, type AppConfig, type Database } from '@ksp/core';
import type pg from 'pg';
import authPlugin from './plugins/auth.js';
import metricsPlugin from './plugins/metrics.js';
import { AppError } from './lib/errors.js';
import { cleanupRateLimitCounters, pgRateLimitStore } from './lib/rate-limit-store.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Database;
    pool: pg.Pool;
    storage: Storage;
    cfg: AppConfig;
    /** Every registered route (method, url, config) — used by the security route sweep test. */
    routeRegistry: Array<{ method: string; url: string; public: boolean }>;
  }
}

export type App = FastifyInstance;

export interface BuildOptions {
  logger?: FastifyServerOptions['logger'] | boolean;
  /** Restrict module autoload (tests). */
  modules?: string[];
}

const here = dirname(fileURLToPath(import.meta.url));

export async function buildApp(opts: BuildOptions = {}): Promise<FastifyInstance> {
  const cfg = loadConfig();
  const app = Fastify({
    loggerInstance: opts.logger === false ? undefined : logger().child({ component: 'http' }),
    logger: opts.logger === false ? false : undefined,
    trustProxy: cfg.TRUST_PROXY,
    genReqId: (req) => (req.headers['x-request-id'] as string)?.slice(0, 64) || randomUUID(),
    bodyLimit: 2 * 1024 * 1024,
    routerOptions: { maxParamLength: 200 },
  } as FastifyServerOptions).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const { db, pool } = createDb();
  app.decorate('db', db);
  app.decorate('pool', pool);
  app.decorate('storage', new Storage());
  app.decorate('cfg', cfg);
  const routeRegistry: Array<{ method: string; url: string; public: boolean }> = [];
  app.decorate('routeRegistry', routeRegistry);
  app.addHook('onRoute', (r) => {
    for (const m of [r.method].flat()) routeRegistry.push({ method: String(m), url: r.url, public: !!(r.config as { public?: boolean } | undefined)?.public });
  });
  app.addHook('onClose', async () => {
    await db.destroy();
  });

  // Raw binary bodies for chunk uploads (application/octet-stream), streamed as Buffer with a per-route limit.
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 128 * 1024 * 1024 }, (_req, body, done) => done(null, body));

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        mediaSrc: ["'self'", 'blob:'],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    hsts: cfg.COOKIE_SECURE ? { maxAge: 31536000, includeSubDomains: true } : false,
  });
  await app.register(cors, {
    origin: cfg.CORS_ORIGINS.split(',').map((s) => s.trim()),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  });
  const rateLimitStore = cfg.RATE_LIMIT_STORE ?? (cfg.NODE_ENV === 'production' ? 'postgres' : 'memory');
  if (rateLimitStore === 'postgres') {
    const timer = setInterval(() => { cleanupRateLimitCounters(pool).catch((err: unknown) => app.log.warn({ err }, 'rate-limit cleanup failed')); }, 60_000);
    timer.unref();
    app.addHook('onClose', async () => clearInterval(timer));
  }
  await app.register(rateLimit, {
    global: true,
    // Shared store: fail open if the DB is unreachable (every limited endpoint needs the DB anyway; keeps /health/live up).
    ...(rateLimitStore === 'postgres' ? { store: pgRateLimitStore(pool) as never, skipOnError: true } : {}),
    max: cfg.NODE_ENV === 'test' ? 100000 : 1200,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.ip,
    errorResponseBuilder: (_req, ctx) => ({ statusCode: 429, error: { code: 'RATE_LIMITED', message: `Rate limit exceeded; retry in ${Math.ceil(ctx.ttl / 1000)}s` } }),
  });
  await app.register(swagger, {
    openapi: {
      info: { title: 'KSP Video Evidence Management API', version: '1.0.0', description: 'REST API for evidence ingestion, search, analysis, custody, export and integration.' },
      components: {
        securitySchemes: {
          bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          cookie: { type: 'apiKey', in: 'cookie', name: 'ksp_at' },
          apiClient: { type: 'http', scheme: 'basic', description: 'Integration API clients: client_id:secret' },
        },
      },
      security: [{ bearer: [] }, { cookie: [] }, { apiClient: [] }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/api/docs' });
  await app.register(metricsPlugin);
  await app.register(authPlugin);

  app.setErrorHandler((err, req, reply) => {
    const requestId = req.id;
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.status(400).send({ error: { code: 'VALIDATION_FAILED', message: 'Request validation failed', details: err.validation, requestId } });
    }
    if (err instanceof AppError) {
      if (err.statusCode >= 500) req.log.error({ err }, err.message);
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details, requestId } });
    }
    const e = err as { statusCode?: number; code?: string; message: string };
    if (e.statusCode === 429) return reply.status(429).send({ error: { code: 'RATE_LIMITED', message: e.message, requestId } });
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ error: { code: e.code ?? 'BAD_REQUEST', message: e.message, requestId } });
    }
    // DB-level guards (immutability triggers) surface as insufficient_privilege.
    if (e.code === '42501') {
      req.log.warn({ err }, 'database guard rejected operation');
      return reply.status(409).send({ error: { code: 'IMMUTABLE', message: e.message, requestId } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Internal server error', requestId } });
  });
  app.setNotFoundHandler((req, reply) => reply.status(404).send({ error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.url.split('?')[0]} not found`, requestId: req.id } }));

  await app.register(import('./health.js'));

  // Module autoload: every directory in src/modules exporting a default plugin is mounted at /api/v1.
  const modulesDir = join(here, 'modules');
  const names = existsSync(modulesDir) ? readdirSync(modulesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort() : [];
  for (const name of names) {
    if (opts.modules && !opts.modules.includes(name)) continue;
    const file = ['index.ts', 'index.js'].map((f) => join(modulesDir, name, f)).find(existsSync);
    if (!file) continue;
    const mod = (await import(pathToFileURL(file).href)) as { default: Parameters<typeof app.register>[0]; prefix?: string };
    await app.register(mod.default, { prefix: `${API_PREFIX}${mod.prefix ?? ''}` });
  }
  return app;
}
