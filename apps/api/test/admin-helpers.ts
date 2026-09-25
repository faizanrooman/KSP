/**
 * Helpers for administration tests. Administrators are MFA-mandatory (sessionPolicy.requireMfaForRoles), so
 * admin sessions are created the real way: password login, TOTP enrolment via the API (otplib), then MFA
 * login. No policy is relaxed.
 */
import { authenticator } from 'otplib';
import { Agent, createUser, getApp, login } from './helpers.js';

export interface AdminSession {
  agent: Agent;
  id: string;
  username: string;
  password: string;
  secret: string;
}

/** Enrol TOTP for the logged-in agent; the current session becomes MFA-verified. Returns the secret. */
export async function enrolMfa(agent: Agent): Promise<string> {
  const setup = await agent.post('/api/v1/auth/mfa/setup');
  if (setup.status !== 200) throw new Error(`mfa setup failed: ${setup.status} ${setup.raw}`);
  const secret = setup.body.secret as string;
  const confirm = await agent.post('/api/v1/auth/mfa/confirm', { code: authenticator.generate(secret) });
  if (confirm.status !== 200) throw new Error(`mfa confirm failed: ${confirm.status} ${confirm.raw}`);
  return secret;
}

/** Full two-step login for an MFA-enrolled user. */
export async function loginWithMfa(username: string, password: string, secret: string): Promise<Agent> {
  const app = await getApp();
  const agent = new Agent(app);
  const s1 = await agent.post('/api/v1/auth/login', { username, password });
  if (s1.status !== 200 || !s1.body.mfaRequired) throw new Error(`login step 1 failed: ${s1.status} ${s1.raw}`);
  const s2 = await agent.post('/api/v1/auth/mfa/verify', { mfaToken: s1.body.mfaToken, code: authenticator.generate(secret) });
  if (s2.status !== 200) throw new Error(`mfa verify failed: ${s2.status} ${s2.raw}`);
  return agent;
}

/** Create a fresh user holding `role` at org unit `org`, log in and (optionally) enrol MFA. */
export async function createAdmin(opts: { org?: string; role?: string; mfa?: boolean } = {}): Promise<AdminSession> {
  const u = await createUser({ role: opts.role ?? 'SYSTEM_ADMINISTRATOR', org: opts.org ?? 'ksp' });
  const agent = await login(u.username, u.password);
  const secret = opts.mfa === false ? '' : await enrolMfa(agent);
  return { agent, ...u, secret };
}

/** A state-level (root) System Administrator with MFA enrolled. */
export const loginAsAdmin = () => createAdmin({ org: 'ksp' });

export async function orgId(code: string): Promise<string> {
  const app = await getApp();
  return (await app.db.selectFrom('org_units').select('id').where('code', '=', code).executeTakeFirstOrThrow()).id;
}

export async function roleId(code: string): Promise<string> {
  const app = await getApp();
  return (await app.db.selectFrom('roles').select('id').where('code', '=', code).executeTakeFirstOrThrow()).id;
}

export async function userIdOf(username: string): Promise<string> {
  const app = await getApp();
  return (await app.db.selectFrom('users').select('id').where('username', '=', username).executeTakeFirstOrThrow()).id;
}

/** Audit events for a resource written after `sinceSeq`. */
export async function auditFor(resourceId: string, action?: string) {
  const app = await getApp();
  let q = app.db.selectFrom('audit_events').select(['seq', 'action', 'outcome', 'details', 'actor_id']).where('resource_id', '=', resourceId);
  if (action) q = q.where('action', '=', action);
  return q.orderBy('seq').execute();
}

export async function lastAudit(action: string) {
  const app = await getApp();
  return app.db.selectFrom('audit_events').select(['seq', 'action', 'outcome', 'details', 'actor_id', 'resource_id']).where('action', '=', action).orderBy('seq', 'desc').limit(1).executeTakeFirst();
}

export async function auditChainIntact(): Promise<boolean> {
  const app = await getApp();
  const { rows } = await app.pool.query('SELECT first_bad_seq FROM audit_verify()');
  return rows[0].first_bad_seq === null;
}

let n = 0;
export const uniq = (prefix: string) => `${prefix}${Date.now().toString(36)}${++n}`;

/**
 * Tests share one source IP (inject => 127.0.0.1); the per-IP failed-login throttle (lockoutPolicy.ipMaxFailedPerWindow)
 * would otherwise start rejecting later test files. Call after a test that deliberately fails logins.
 */
export async function clearLoginFailures(): Promise<void> {
  const app = await getApp();
  await app.db.deleteFrom('login_attempts').where('success', '=', false).execute();
}
