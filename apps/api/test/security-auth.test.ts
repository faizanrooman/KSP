/**
 * JWT / session / MFA attacks (security round 2): alg=none, HS256 signed with the public key (alg confusion),
 * expired, wrong iss/aud, typ:'mfa' as access, sub/sid mismatch, token after logout / password change / user
 * disabled, session fixation, MFA lockout (SEC-11), TOTP replay (SEC-12), login timing (user enumeration).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT, importPKCS8 } from 'jose';
import { randomUUID } from 'node:crypto';
import { authenticator } from 'otplib';
import type { FastifyInstance } from 'fastify';
import { ACCESS_COOKIE } from '@ksp/shared';
import { loadConfig } from '@ksp/core';
import { Agent, closeApp, createUser, getApp, login, nextTotp } from './helpers.js';
import { invalidatePrincipals } from '../src/lib/load-principal.js';

let app: FastifyInstance;
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

beforeAll(async () => {
  app = await getApp();
});
afterAll(closeApp);

async function sign(claims: Record<string, unknown>, opts: { iss?: string; aud?: string; exp?: number; alg?: string } = {}) {
  const cfg = loadConfig();
  const key = await importPKCS8(cfg.JWT_PRIVATE_KEY, 'EdDSA');
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuer(opts.iss ?? cfg.JWT_ISSUER)
    .setAudience(opts.aud ?? cfg.JWT_ISSUER)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? Math.floor(Date.now() / 1000) + 600)
    .sign(key);
}

const me = (token: string, via: 'bearer' | 'cookie' = 'bearer') =>
  app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: via === 'bearer' ? { authorization: `Bearer ${token}` } : { cookie: `${ACCESS_COOKIE}=${token}` } });

async function bearerLogin(username: string, password = 'Ksp@Dev-Passw0rd!') {
  const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password, tokenMode: 'bearer' } });
  expect(r.statusCode).toBe(200);
  return r.json() as { accessToken: string; refreshToken: string; me: { sessionId: string; user: { id: string } } };
}

describe('JWT forgery', () => {
  it('a genuine token works (control)', async () => {
    const t = await bearerLogin('io.meera');
    expect((await me(t.accessToken)).statusCode).toBe(200);
  });

  it('refuses alg=none, HS256-with-public-key, expired, wrong iss/aud, typ=mfa, sub/sid mismatch, garbage', async () => {
    const t = await bearerLogin('io.meera');
    const sub = t.me.user.id;
    const sid = t.me.sessionId;
    const cfg = loadConfig();
    const payload = { sub, sid, typ: 'access', iss: cfg.JWT_ISSUER, aud: cfg.JWT_ISSUER, exp: Math.floor(Date.now() / 1000) + 600 };
    const hsKey = new TextEncoder().encode(cfg.JWT_PUBLIC_KEY);
    const forged: Record<string, string> = {
      algNone: `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.`,
      algNoneCaps: `${b64({ alg: 'NONE' })}.${b64(payload)}.`,
      hs256PublicKey: await new SignJWT(payload).setProtectedHeader({ alg: 'HS256' }).sign(hsKey),
      expired: await sign({ sub, sid, typ: 'access' }, { exp: Math.floor(Date.now() / 1000) - 5 }),
      wrongIss: await sign({ sub, sid, typ: 'access' }, { iss: 'evil' }),
      wrongAud: await sign({ sub, sid, typ: 'access' }, { aud: 'other-app' }),
      mfaTyp: await sign({ sub, sid, typ: 'mfa' }),
      noTyp: await sign({ sub, sid }),
      otherSub: await sign({ sub: randomUUID(), sid, typ: 'access' }),
      unknownSid: await sign({ sub, sid: randomUUID(), typ: 'access' }),
      tamperedPayload: `${t.accessToken.split('.')[0]}.${b64({ ...payload, sub: randomUUID() })}.${t.accessToken.split('.')[2]}`,
      garbage: 'not.a.jwt',
    };
    for (const [name, tok] of Object.entries(forged)) {
      const r1 = await me(tok, 'bearer');
      const r2 = await me(tok, 'cookie');
      expect({ name, bearer: r1.statusCode, cookie: r2.statusCode }).toEqual({ name, bearer: 401, cookie: 401 });
      expect(r1.body).not.toMatch(/stack|at .*\.ts/);
    }
  });

  it('the typ:mfa step-up token cannot be used as an access token even with a real session id', async () => {
    const u = await createUser({ role: 'INVESTIGATING_OFFICER', org: 'ps_cubbonpark' });
    const ag = await login(u.username);
    const secret = (await ag.post('/api/v1/auth/mfa/setup')).body.secret as string;
    expect((await ag.post('/api/v1/auth/mfa/confirm', { code: authenticator.generate(secret) })).status).toBe(200);
    const step1 = await new Agent(app).post('/api/v1/auth/login', { username: u.username, password: u.password });
    const mfaToken = step1.body.mfaToken as string;
    expect((await me(mfaToken)).statusCode).toBe(401);
    expect((await me(mfaToken, 'cookie')).statusCode).toBe(401);
    // …nor an access token as the MFA token.
    const acc = await bearerLogin('io.meera');
    const r = await app.inject({ method: 'POST', url: '/api/v1/auth/mfa/verify', payload: { mfaToken: acc.accessToken, code: '123456' } });
    expect(r.statusCode).toBe(401);
  });
});

describe('session lifecycle', () => {
  it('access token dies at logout; refresh token too', async () => {
    const t = await bearerLogin('io.meera');
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { authorization: `Bearer ${t.accessToken}` } })).statusCode).toBe(200);
    expect((await me(t.accessToken)).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: t.refreshToken } })).statusCode).toBe(401);
  });

  it('password change kills every OTHER session (access + refresh) immediately', async () => {
    const u = await createUser({ role: 'INVESTIGATING_OFFICER', org: 'ps_cubbonpark' });
    const other = await bearerLogin(u.username, u.password);
    const cur = await bearerLogin(u.username, u.password);
    const r = await app.inject({ method: 'POST', url: '/api/v1/auth/password/change', headers: { authorization: `Bearer ${cur.accessToken}` }, payload: { currentPassword: u.password, newPassword: 'N3w-Str0ng!Passphrase#2026' } });
    expect(r.statusCode).toBe(200);
    expect((await me(other.accessToken)).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: other.refreshToken } })).statusCode).toBe(401);
    expect((await me(cur.accessToken)).statusCode).toBe(200);
  });

  it('a disabled user loses access with an existing token and cannot refresh', async () => {
    const u = await createUser({ role: 'INVESTIGATING_OFFICER', org: 'ps_cubbonpark' });
    const t = await bearerLogin(u.username, u.password);
    await app.db.updateTable('users').set({ status: 'DISABLED' } as never).where('id', '=', u.id).execute();
    invalidatePrincipals(u.id);
    expect((await me(t.accessToken)).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: t.refreshToken } })).statusCode).toBe(401);
  });

  it('session fixation: cookies planted before login are replaced by a brand-new session', async () => {
    const attacker = await bearerLogin('io.arjun');
    const victim = new Agent(app);
    victim.cookies.set(ACCESS_COOKIE, attacker.accessToken);
    victim.cookies.set('ksp_rt', attacker.refreshToken);
    // The planted cookie authenticates as the ATTACKER, never as the victim.
    expect((await victim.get('/api/v1/auth/me')).body.user.username).toBe('io.arjun');
    victim.cookies.set('ksp_csrf', 'attacker-chosen-csrf-value');
    const l = await victim.post('/api/v1/auth/login', { username: 'io.meera', password: 'Ksp@Dev-Passw0rd!' });
    // The response rotates every auth cookie, including the (attacker-chosen) CSRF cookie.
    expect(l.status).toBe(200);
    expect(victim.cookies.get(ACCESS_COOKIE)).not.toBe(attacker.accessToken);
    expect(victim.cookies.get('ksp_csrf')).not.toBe('attacker-chosen-csrf-value');
    expect(l.body.me.sessionId).not.toBe(attacker.me.sessionId);
    expect((await victim.get('/api/v1/auth/me')).body.user.username).toBe('io.meera');
    // The attacker's token still identifies only the attacker (the victim's login did not upgrade it).
    expect((await me(attacker.accessToken)).json().user.username).toBe('io.arjun');
  });
});

describe('MFA hardening', () => {
  async function mfaUser() {
    const u = await createUser({ role: 'INVESTIGATING_OFFICER', org: 'ps_cubbonpark' });
    const ag = await login(u.username);
    const secret = (await ag.post('/api/v1/auth/mfa/setup')).body.secret as string;
    expect((await ag.post('/api/v1/auth/mfa/confirm', { code: authenticator.generate(secret) })).status).toBe(200);
    return { ...u, secret };
  }
  const step1 = async (u: { username: string; password: string }) => (await new Agent(app).post('/api/v1/auth/login', { username: u.username, password: u.password })).body.mfaToken as string;
  const verify = (mfaToken: string, code: string) => app.inject({ method: 'POST', url: '/api/v1/auth/mfa/verify', payload: { mfaToken, code, tokenMode: 'bearer' } });

  it('SEC-11: after the lockout threshold the correct TOTP code is refused (423) for the same mfaToken', async () => {
    const u = await mfaUser();
    const tok = await step1(u);
    for (let i = 0; i < 5; i++) expect((await verify(tok, '000000')).statusCode).toBe(401);
    const r = await verify(tok, await nextTotp(u.secret, u.username));
    expect(r.statusCode).toBe(423);
    expect(r.json().error.code).toBe('ACCOUNT_LOCKED');
  });

  it('SEC-12: a TOTP code is single-use (replay within its window refused), also against concurrent replays', async () => {
    const u = await mfaUser();
    const code = await nextTotp(u.secret, u.username);
    const [t1, t2, t3] = await Promise.all([step1(u), step1(u), step1(u)]);
    const rs = await Promise.all([verify(t1, code), verify(t2, code)]);
    expect(rs.map((r) => r.statusCode).sort()).toEqual([200, 401]);
    expect((await verify(t3, code)).statusCode).toBe(401);
    // The enrolment code is consumed as well.
    const v = await mfaUser();
    const enrolCode = authenticator.generate(v.secret);
    const last = (await app.db.selectFrom('users').select('mfa_last_totp_step').where('id', '=', v.id).executeTakeFirstOrThrow()).mfa_last_totp_step;
    if (Number(last) === Math.floor(Date.now() / 30_000)) expect((await verify(await step1(v), enrolCode)).statusCode).toBe(401);
  });
});

describe('login timing (user enumeration)', () => {
  it('median latency for an existing vs a non-existing user differs by < 25 % (30 attempts each)', async () => {
    const u = await createUser({ role: 'INVESTIGATING_OFFICER', org: 'ps_cubbonpark' });
    const attempt = async (username: string, i: number) => {
      const t0 = process.hrtime.bigint();
      const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', remoteAddress: `10.77.${Math.floor(i / 200)}.${i % 200 + 1}`, payload: { username, password: 'Wrong-Passw0rd!x' } });
      expect(r.statusCode).toBe(401);
      return Number(process.hrtime.bigint() - t0) / 1e6;
    };
    for (let i = 0; i < 4; i++) await attempt(`ghost_${i}`, 900 + i); // warm-up
    const ex: number[] = [];
    const nx: number[] = [];
    // Interleave so drift (GC, other load) affects both series equally.
    for (let i = 0; i < 30; i++) {
      ex.push(await attempt(u.username, i * 2));
      nx.push(await attempt(`nobody_${randomUUID().slice(0, 8)}`, i * 2 + 1));
    }
    const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
    const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!;
    const diff = Math.abs(mean(ex) - mean(nx)) / Math.min(mean(ex), mean(nx));
    const mdiff = Math.abs(med(ex) - med(nx)) / Math.min(med(ex), med(nx));
    console.log(`[login timing] existing mean ${mean(ex).toFixed(1)} ms (median ${med(ex).toFixed(1)}), non-existing mean ${mean(nx).toFixed(1)} ms (median ${med(nx).toFixed(1)}), mean diff ${(diff * 100).toFixed(1)} %, median diff ${(mdiff * 100).toFixed(1)} %`);
    // Medians are robust to GC pauses; the mean difference (~2-3 ms: the failed_login_count UPDATE) is reported.
    expect(mdiff).toBeLessThan(0.25);
    expect(diff).toBeLessThan(0.5);
  }, 120_000);
});
