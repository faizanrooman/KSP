import fp from 'fastify-plugin';
import { BlockList, isIP } from 'node:net';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ACCESS_COOKIE, CSRF_COOKIE, CSRF_HEADER, type Permission } from '@ksp/shared';
import { appendAudit, type AuditActor } from '@ksp/core';
import { verifyApiClientSecret } from '../lib/api-client-auth.js';
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

  // Tender §50 — staff application reachable from authorised internal networks only.
  const allowedNetworks = app.cfg.ALLOWED_NETWORKS.split(',').map((s) => s.trim()).filter(Boolean);
  const exemptPrefixes = app.cfg.ALLOWED_NETWORKS_EXEMPT_PREFIXES.split(',').map((s) => s.trim()).filter(Boolean);
  const networkDenials = new Map<string, number>(); // ip -> last audited (ms); one audit row per ip per minute
  app.addHook('onRequest', async (req) => {
    if (allowedNetworks.length && (req.url.startsWith('/api/') || req.url === '/')) {
      const path = req.url.split('?')[0]!;
      if (!exemptPrefixes.some((p) => path.startsWith(p)) && !allowedNetworks.some((c) => ipInCidr(req.ip, c))) {
        const last = networkDenials.get(req.ip) ?? 0;
        if (Date.now() - last > 60_000) {
          networkDenials.set(req.ip, Date.now());
          await appendAudit(app.db, { type: 'USER', id: null, ip: req.ip, userAgent: req.headers['user-agent'] ?? null }, {
            action: 'ACCESS_DENIED', outcome: 'DENIED', resourceType: 'network', resourceId: req.ip, details: { reason: 'NETWORK_NOT_ALLOWED', path },
          });
        }
        throw new AppError(403, 'NETWORK_NOT_ALLOWED', 'This service is only available from authorised police networks');
      }
    }
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
      // SEC-R8: unknown / expired ids verify against a dummy argon2 hash (uniform timing); positive results are cached ≤ 60 s.
      const live = client && secret && (!client.expires_at || client.expires_at > new Date()) ? client : undefined;
      const valid = (await verifyApiClientSecret(clientId ?? '', secret ?? '', live)) && !!live;
      const ipOk = valid && (live.allowed_ips.length === 0 || live.allowed_ips.some((c) => ipInCidr(req.ip, c)));
      if (!valid || !ipOk || !client) {
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
            // Sliding idle timeout (throttled writes). Background requests (auto-refresh / polling sent without recent user
            // activity, header x-ksp-background) do not extend it, so an unattended screen signs out after the idle timeout.
            if (req.headers['x-ksp-background'] !== '1' && now.getTime() - session.last_seen_at.getTime() > 60_000) {
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
  // IPv4 and IPv6 subnets (and exact addresses) via node:net BlockList; IPv4-mapped IPv6 clients (::ffff:a.b.c.d)
  // match IPv4 entries. Invalid entries/addresses never match.
  const [range, bitsStr] = cidr.trim().split('/');
  if (!range) return false;
  const clean = ip.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
  const family = isIP(range);
  const ipFamily = isIP(clean);
  if (!family || !ipFamily || family !== ipFamily) return false;
  const type = family === 6 ? 'ipv6' : 'ipv4';
  const bits = bitsStr === undefined ? (family === 6 ? 128 : 32) : Number(bitsStr);
  if (!Number.isInteger(bits) || bits < 0 || bits > (family === 6 ? 128 : 32)) return false;
  try {
    const list = new BlockList();
    list.addSubnet(range, bits, type);
    return list.check(clean, type);
  } catch {
    return false;
  }
}
