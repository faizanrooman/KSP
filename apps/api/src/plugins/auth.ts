import fp from 'fastify-plugin';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ACCESS_COOKIE, CSRF_COOKIE, CSRF_HEADER, type Permission } from '@ksp/shared';
import { appendAudit, verifySecret, type AuditActor } from '@ksp/core';
import { verifyJwt } from '../lib/session.js';
import { loadApiClientPrincipal, loadUserPrincipal } from '../lib/load-principal.js';
import { hasPermission, type Principal } from '../lib/principal.js';
import { AppError, forbidden, unauthenticated } from '../lib/errors.js';
import { getSettings } from '../lib/settings.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
    /** Audit actor for the current request (anonymous if unauthenticated). */
    actor(): AuditActor;
    /** The authenticated principal; throws 401 when absent. */
    requirePrincipal(): Principal;
  }
  interface FastifyContextConfig {
    /** Route does not require authentication. */
    public?: boolean;
    /** Route remains reachable while the user must change password / enrol MFA. */
    allowRestricted?: boolean;
  }
  interface FastifyInstance {
    /** preHandler requiring ALL listed permissions (jurisdiction-independent). */
    authorize(...perms: Permission[]): (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export default fp(async (app) => {
  app.decorateRequest('principal', null);
  app.decorateRequest('actor', function (this: FastifyRequest): AuditActor {
    const p = this.principal;
    return {
      type: p ? (p.kind === 'API_CLIENT' ? 'API_CLIENT' : 'USER') : 'USER',
      id: p ? (p.userId ?? p.apiClientId ?? null) : null,
      name: p?.username ?? null,
      ip: this.ip,
      userAgent: this.headers['user-agent'] ?? null,
      sessionId: p?.sessionId ?? null,
    };
  });
  app.decorateRequest('requirePrincipal', function (this: FastifyRequest): Principal {
    if (!this.principal) throw unauthenticated();
    return this.principal;
  });

  app.decorate('authorize', (...perms: Permission[]) => async (req: FastifyRequest) => {
    const p = req.requirePrincipal();
    const missing = perms.filter((perm) => !hasPermission(p, perm));
    if (missing.length) {
      await appendAudit(app.db, req.actor(), {
        action: 'ACCESS_DENIED',
        outcome: 'DENIED',
        resourceType: 'route',
        resourceId: `${req.method} ${req.routeOptions.url}`,
        details: { missing },
      });
      throw forbidden();
    }
  });

  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    // OpenAPI docs are open outside production; in production they require an authenticated session.
    if (req.url.startsWith('/api/docs') && app.cfg.NODE_ENV !== 'production') return;
    const cfg = req.routeOptions.config;
    const auth = req.headers.authorization;
    let bearer = false;
    let token: string | undefined;
    if (auth?.startsWith('Bearer ')) {
      token = auth.slice(7);
      bearer = true;
    } else if (auth?.startsWith('Basic ')) {
      // API client credentials (integration REST API): Basic base64(client_id:secret)
      const [clientId, secret] = Buffer.from(auth.slice(6), 'base64').toString('utf8').split(':');
      const client = clientId
        ? await app.db.selectFrom('api_clients').selectAll().where('client_id', '=', clientId).where('revoked_at', 'is', null).executeTakeFirst()
        : undefined;
      const valid = client && secret && (!client.expires_at || client.expires_at > new Date()) && (await verifySecret(client.secret_hash, secret));
      const ipOk = valid && (client.allowed_ips.length === 0 || client.allowed_ips.some((c) => ipInCidr(req.ip, c)));
      if (!valid || !ipOk) {
        await appendAudit(app.db, { type: 'API_CLIENT', id: clientId ?? null, ip: req.ip, userAgent: req.headers['user-agent'] ?? null }, {
          action: 'LOGIN_FAILED', outcome: 'FAILURE', resourceType: 'api_client', details: { reason: valid ? 'IP_NOT_ALLOWED' : 'BAD_CREDENTIALS' },
        });
        throw unauthenticated('Invalid client credentials');
      }
      await app.db.updateTable('api_clients').set({ last_used_at: new Date() }).where('id', '=', client.id).execute();
      req.principal = await loadApiClientPrincipal(app.db, client);
      // API clients may only use the external integration REST API (/api/v1/integration/*) and tokenised downloads.
      if (!req.url.startsWith('/api/v1/integration/') && !req.url.startsWith('/api/v1/media/download/')) {
        throw new AppError(403, 'API_CLIENT_ROUTE_FORBIDDEN', 'API clients may only call the integration API (/api/v1/integration)');
      }
      return;
    } else {
      token = req.cookies[ACCESS_COOKIE];
    }

    if (token) {
      const claims = await verifyJwt(token, 'access').catch(() => null);
      if (claims) {
        const session = await app.db
          .selectFrom('sessions')
          .select(['id', 'user_id', 'revoked_at', 'idle_expires_at', 'absolute_expires_at', 'last_seen_at', 'mfa_verified'])
          .where('id', '=', claims.sid)
          .executeTakeFirst();
        const now = new Date();
        if (session && !session.revoked_at && session.idle_expires_at > now && session.absolute_expires_at > now && session.user_id === claims.sub) {
          const principal = await loadUserPrincipal(app.db, session.user_id, session.id, session.mfa_verified);
          if (principal) {
            req.principal = principal;
            // Sliding idle timeout (throttled writes).
            if (now.getTime() - session.last_seen_at.getTime() > 60_000) {
              const settings = await getSettings(app.db);
              const idle = new Date(Math.min(session.absolute_expires_at.getTime(), now.getTime() + settings.sessionPolicy.idleTimeoutMinutes * 60_000));
              await app.db.updateTable('sessions').set({ last_seen_at: now, idle_expires_at: idle }).where('id', '=', session.id).execute();
            }
          }
        }
      }
    }

    // CSRF: cookie-authenticated unsafe requests need the double-submit header + an allowed Origin.
    if (!bearer && UNSAFE.has(req.method) && req.cookies[ACCESS_COOKIE]) {
      const header = req.headers[CSRF_HEADER];
      const cookie = req.cookies[CSRF_COOKIE];
      const origin = req.headers.origin;
      const allowed = app.cfg.CORS_ORIGINS.split(',').map((s) => s.trim());
      if (!cookie || header !== cookie || (origin && !allowed.includes(origin) && origin !== app.cfg.APP_BASE_URL)) {
        throw new AppError(403, 'CSRF_FAILED', 'CSRF validation failed');
      }
    }

    if (cfg?.public) return;
    if (!req.principal) throw unauthenticated();
    if (!cfg?.allowRestricted && (req.principal.mustChangePassword || req.principal.mfaEnrollmentRequired)) {
      throw new AppError(403, req.principal.mustChangePassword ? 'PASSWORD_CHANGE_REQUIRED' : 'MFA_ENROLLMENT_REQUIRED',
        req.principal.mustChangePassword ? 'You must change your password before continuing' : 'You must enrol in multi-factor authentication before continuing');
    }
  });
});

/** IPv4 CIDR membership (IPv6 exact match). */
export function ipInCidr(ip: string, cidr: string): boolean {
  const [range, bitsStr] = cidr.split('/');
  if (!range) return false;
  const clean = ip.replace(/^::ffff:/, '');
  if (!range.includes('.') || !clean.includes('.')) return clean === range;
  const bits = Number(bitsStr ?? 32);
  const toInt = (v: string) => v.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (toInt(clean) & mask) === (toInt(range) & mask);
}
