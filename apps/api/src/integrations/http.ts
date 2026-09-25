/**
 * Minimal JSON-over-HTTP client for integration adapters: egress guard (SSRF), timeouts, bounded retries with
 * backoff, response size limit, auth from secret references (never from the DB), no redirects.
 *
 * Secrets: `credentials_ref` = NAME. The secret is read from env at call time:
 *   bearer: KSP_SECRET_<NAME>                -> "Authorization: Bearer <value>"
 *   basic:  KSP_SECRET_<NAME>                -> "user:password"
 *   mtls:   KSP_SECRET_<NAME>_CERT / _KEY / _CA  -> FILE PATHS of PEM client cert, key and (optional) CA bundle
 */
import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { egressPolicy, guardedLookup, validateBaseUrl } from './egress.js';
import { IntegrationError } from './types.js';

export type AuthType = 'none' | 'bearer' | 'basic' | 'mtls';

export interface HttpTarget {
  baseUrl: string;
  authType: AuthType;
  credentialsRef: string | null;
  timeoutMs: number;
  retries: number;
}

export interface HttpResult {
  status: number;
  json: unknown;
}

const MAX_BODY = 5 * 1024 * 1024;
const REF_RE = /^[A-Z0-9_]{2,64}$/;

export function secretEnvName(ref: string, suffix = ''): string {
  return `KSP_SECRET_${ref}${suffix}`;
}

/** Whether the secret(s) named by credentialsRef are present in the environment (never returns the value). */
export function credentialsPresent(authType: AuthType, ref: string | null): boolean {
  if (authType === 'none') return true;
  if (!ref || !REF_RE.test(ref)) return false;
  if (authType === 'mtls') return !!process.env[secretEnvName(ref, '_CERT')] && !!process.env[secretEnvName(ref, '_KEY')];
  return !!process.env[secretEnvName(ref)];
}

function authOptions(t: HttpTarget): { headers: Record<string, string>; tls: https.RequestOptions } {
  if (t.authType === 'none') return { headers: {}, tls: {} };
  if (!t.credentialsRef || !REF_RE.test(t.credentialsRef)) throw new IntegrationError('NOT_CONFIGURED', 'credentialsRef is missing or invalid');
  if (t.authType === 'mtls') {
    const cert = process.env[secretEnvName(t.credentialsRef, '_CERT')];
    const key = process.env[secretEnvName(t.credentialsRef, '_KEY')];
    const ca = process.env[secretEnvName(t.credentialsRef, '_CA')];
    if (!cert || !key) throw new IntegrationError('NOT_CONFIGURED', `mTLS secret files ${secretEnvName(t.credentialsRef, '_CERT|_KEY')} not configured`);
    try {
      return { headers: {}, tls: { cert: readFileSync(cert), key: readFileSync(key), ...(ca ? { ca: readFileSync(ca) } : {}) } };
    } catch {
      throw new IntegrationError('NOT_CONFIGURED', 'mTLS certificate/key files could not be read');
    }
  }
  const secret = process.env[secretEnvName(t.credentialsRef)];
  if (!secret) throw new IntegrationError('NOT_CONFIGURED', `Secret ${secretEnvName(t.credentialsRef)} is not configured`);
  if (t.authType === 'bearer') return { headers: { authorization: `Bearer ${secret}` }, tls: {} };
  return { headers: { authorization: `Basic ${Buffer.from(secret).toString('base64')}` }, tls: {} };
}

function once(t: HttpTarget, method: string, path: string, body: unknown): Promise<HttpResult> {
  const policy = egressPolicy();
  const base = validateBaseUrl(t.baseUrl, policy);
  const url = new URL(path.replace(/^\//, ''), base.href.endsWith('/') ? base.href : `${base.href}/`);
  if (url.origin !== base.origin) throw new IntegrationError('BLOCKED_DESTINATION', 'Request path escapes the configured base URL');
  const { headers, tls } = authOptions(t);
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise<HttpResult>((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method,
        headers: {
          accept: 'application/json',
          'user-agent': 'KSP-VEMS-Integration/1.0',
          ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
          ...headers,
        },
        lookup: guardedLookup(policy) as never,
        timeout: t.timeoutMs,
        ...tls,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_BODY) {
            req.destroy(new IntegrationError('CONTRACT_MISMATCH', 'Upstream response too large'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          const text = Buffer.concat(chunks).toString('utf8');
          let json: unknown = undefined;
          if (text) {
            try {
              json = JSON.parse(text);
            } catch {
              if (status >= 200 && status < 300) return reject(new IntegrationError('CONTRACT_MISMATCH', 'Upstream returned non-JSON body', status));
            }
          }
          resolve({ status, json });
        });
        res.on('error', reject);
      },
    );
    const timer = setTimeout(() => req.destroy(new IntegrationError('TIMEOUT', `Upstream did not respond within ${t.timeoutMs} ms`)), t.timeoutMs);
    req.on('timeout', () => req.destroy(new IntegrationError('TIMEOUT', `Upstream did not respond within ${t.timeoutMs} ms`)));
    req.on('close', () => clearTimeout(timer));
    req.on('error', (e) => {
      if (e instanceof IntegrationError) return reject(e);
      reject(new IntegrationError('UPSTREAM_ERROR', `Connection failed: ${(e as NodeJS.ErrnoException).code ?? e.message}`));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Request with retries (network errors, timeouts, 429 and 5xx; never on other 4xx or guard failures).
 * 404 is returned to the caller (adapters decide whether it means "not found"); 401/403 -> UNAUTHORIZED.
 */
export async function requestJson(t: HttpTarget, method: string, path: string, body?: unknown): Promise<HttpResult> {
  let last: IntegrationError | undefined;
  for (let attempt = 0; attempt <= t.retries; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, Math.min(2000, 150 * 2 ** (attempt - 1))));
    try {
      const res = await once(t, method, path, body);
      if (res.status === 401 || res.status === 403) throw new IntegrationError('UNAUTHORIZED', `Upstream rejected our credentials (HTTP ${res.status})`, res.status);
      if (res.status === 429 || res.status >= 500) {
        last = new IntegrationError('UPSTREAM_ERROR', `Upstream error HTTP ${res.status}`, res.status);
        continue;
      }
      if (res.status >= 300 && res.status < 400) throw new IntegrationError('UPSTREAM_ERROR', `Upstream redirect (HTTP ${res.status}) not followed`, res.status);
      if (res.status >= 400 && res.status !== 404) throw new IntegrationError('UPSTREAM_ERROR', `Upstream rejected the request (HTTP ${res.status})`, res.status);
      return res;
    } catch (e) {
      const err = e instanceof IntegrationError ? e : new IntegrationError('UPSTREAM_ERROR', (e as Error).message);
      if (err.code === 'TIMEOUT' || (err.code === 'UPSTREAM_ERROR' && err.upstreamStatus === undefined)) {
        last = err;
        continue;
      }
      throw err;
    }
  }
  throw last ?? new IntegrationError('UPSTREAM_ERROR', 'Upstream request failed');
}
