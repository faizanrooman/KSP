import type { FastifyInstance, InjectOptions } from 'fastify';
import { CSRF_COOKIE, CSRF_HEADER } from '@ksp/shared';
import { DEV_PASSWORD } from '@ksp/core/dev-seed';
import { getQueue, hashSecret } from '@ksp/core';
import { QUEUES, type SnapshotExtractPayload } from '@ksp/shared';
import type { PgBoss } from 'pg-boss';
import { runSnapshotExtract } from '../../worker/src/jobs/media/snapshot.js';
import { authenticator } from 'otplib';
import { buildApp } from '../src/app.js';

/**
 * A TOTP code the server will accept now. Codes are single-use per 30 s step (SEC-12), so after enrolment or a
 * previous login this returns the code for the NEXT unused step (inside the ±1 step window), waiting only if the
 * next step is already used as well.
 */
export async function nextTotp(secret: string, username: string): Promise<string> {
  const app = await getApp();
  for (;;) {
    const u = await app.db.selectFrom('users').select('mfa_last_totp_step').where('username', '=', username).executeTakeFirstOrThrow();
    const now = Math.floor(Date.now() / 30_000);
    const step = Math.max(now, Number(u.mfa_last_totp_step ?? -1) + 1);
    if (step <= now + 1) return authenticator.clone({ epoch: step * 30_000 + 1_000 }).generate(secret);
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

let appPromise: Promise<FastifyInstance> | undefined;

/** One app instance per test file (closed in afterAll via closeApp). */
export function getApp(): Promise<FastifyInstance> {
  return (appPromise ??= buildApp({ logger: false }).then(async (app) => {
    await startSnapshotConsumer(app);
    return app;
  }));
}

/**
 * Snapshot extraction runs in the worker (media.snapshot, FN-8) and the API waits for it. API tests consume that
 * queue in-process with the REAL worker handler (real queue, FFmpeg, S3, DB) so POST /snapshots behaves as deployed.
 */
let snapshotBoss: PgBoss | undefined;
async function startSnapshotConsumer(app: FastifyInstance): Promise<void> {
  snapshotBoss = await getQueue();
  await snapshotBoss.work<SnapshotExtractPayload>(QUEUES.SNAPSHOT_EXTRACT, { pollingIntervalSeconds: 0.5, localConcurrency: 2 }, async (jobs) => {
    for (const j of jobs) await runSnapshotExtract({ db: app.db, storage: app.storage, cfg: app.cfg }, j.data.snapshotRequestId);
  });
}

export async function closeApp(): Promise<void> {
  if (appPromise) {
    const app = await appPromise;
    appPromise = undefined;
    await snapshotBoss?.offWork(QUEUES.SNAPSHOT_EXTRACT).catch(() => undefined);
    snapshotBoss = undefined;
    await app.close();
  }
}

export interface Res {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  headers: Record<string, unknown>;
  raw: string;
}

/** A logged-in browser-like client (cookies + CSRF double submit). */
export class Agent {
  cookies = new Map<string, string>();
  constructor(readonly app: FastifyInstance) {}

  async request(method: InjectOptions['method'], url: string, opts: { body?: unknown; headers?: Record<string, string>; payload?: Buffer | string } = {}): Promise<Res> {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const csrf = this.cookies.get(CSRF_COOKIE);
    if (csrf && !headers[CSRF_HEADER]) headers[CSRF_HEADER] = csrf;
    const res = await this.app.inject({ method, url, headers, ...(opts.payload !== undefined ? { payload: opts.payload } : opts.body !== undefined ? { payload: opts.body as object } : {}) });
    for (const c of res.cookies) {
      if (!c.value || (c.expires && new Date(c.expires) < new Date())) this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
    }
    let body: unknown = undefined;
    try {
      body = res.json();
    } catch {
      body = undefined;
    }
    return { status: res.statusCode, body, headers: res.headers, raw: res.body };
  }
  get = (url: string, headers?: Record<string, string>) => this.request('GET', url, { headers });
  post = (url: string, body?: unknown, headers?: Record<string, string>) => this.request('POST', url, { body: body ?? {}, headers });
  put = (url: string, body?: unknown) => this.request('PUT', url, { body: body ?? {} });
  patch = (url: string, body?: unknown) => this.request('PATCH', url, { body: body ?? {} });
  delete = (url: string, body?: unknown) => this.request('DELETE', url, body === undefined ? {} : { body });
}

export async function login(username: string, password = DEV_PASSWORD): Promise<Agent> {
  const app = await getApp();
  const agent = new Agent(app);
  const res = await agent.post('/api/v1/auth/login', { username, password });
  if (res.status !== 200) throw new Error(`login ${username} failed: ${res.status} ${res.raw}`);
  return agent;
}

let counter = 0;
/** Create an ad-hoc ACTIVE user with the given role at the given org unit code. Returns username. */
export async function createUser(opts: { role: string; org: string; username?: string; password?: string; mustChange?: boolean }): Promise<{ id: string; username: string; password: string }> {
  const app = await getApp();
  const username = opts.username ?? `t_${Date.now().toString(36)}_${++counter}`;
  const password = opts.password ?? DEV_PASSWORD;
  const org = await app.db.selectFrom('org_units').select('id').where('code', '=', opts.org).executeTakeFirstOrThrow();
  const role = await app.db.selectFrom('roles').select('id').where('code', '=', opts.role).executeTakeFirstOrThrow();
  const hash = await hashSecret(password);
  const u = await app.db.insertInto('users').values({ username, full_name: `Test ${username}`, home_org_unit_id: org.id, password_hash: hash, password_changed_at: new Date(), must_change_password: opts.mustChange ?? false }).returning('id').executeTakeFirstOrThrow();
  await app.db.insertInto('password_history').values({ user_id: u.id, password_hash: hash }).execute();
  await app.db.insertInto('user_roles').values({ user_id: u.id, role_id: role.id, org_unit_id: org.id }).execute();
  return { id: u.id, username, password };
}
