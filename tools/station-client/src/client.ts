/**
 * Minimal KSP API client for the station uploader: bearer tokens (tokenMode=bearer), automatic refresh
 * before expiry and once on 401, JSON + raw chunk requests. Uses Node 22 built-in fetch only.
 */
import { API_PREFIX, CHUNK_SHA256_HEADER } from '@ksp/shared';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
  /** Worth retrying (network blip, server busy, transit corruption of a chunk). */
  get retryable(): boolean {
    return this.status === 0 || this.status >= 500 || this.status === 429 || this.status === 408 || this.code === 'CHUNK_HASH_MISMATCH';
  }
}

export interface Credentials {
  username: string;
  password: string;
  /** Called only when the account has MFA enabled. Returns a 6-digit TOTP code. */
  totp: () => Promise<string>;
}

interface Tokens {
  accessToken: string;
  accessExpiresAt: number;
  refreshToken: string;
}

export class KspClient {
  private tokens: Tokens | null = null;
  private refreshing: Promise<void> | null = null;
  readonly base: string;

  constructor(server: string, private readonly userAgent = 'ksp-station-client/1.0') {
    this.base = server.replace(/\/+$/, '') + API_PREFIX;
  }

  async login(c: Credentials): Promise<{ fullName: string; username: string; mustChangePassword: boolean; mfaEnrollmentRequired: boolean }> {
    let res = await this.raw('POST', '/auth/login', { json: { username: c.username, password: c.password, tokenMode: 'bearer' }, auth: false });
    if ((res as { mfaRequired?: boolean }).mfaRequired) {
      const code = (await c.totp()).trim();
      res = await this.raw('POST', '/auth/mfa/verify', { json: { mfaToken: (res as { mfaToken: string }).mfaToken, code, tokenMode: 'bearer' }, auth: false });
    }
    const r = res as { accessToken: string; accessExpiresAt: string; refreshToken: string; me: { user: { fullName: string; username: string; mustChangePassword: boolean; mfaEnrollmentRequired: boolean } } };
    this.setTokens(r);
    return r.me.user;
  }

  async logout(): Promise<void> {
    if (!this.tokens) return;
    await this.request('POST', '/auth/logout', {}).catch(() => undefined);
    this.tokens = null;
  }

  private setTokens(r: { accessToken: string; accessExpiresAt: string; refreshToken: string }) {
    this.tokens = { accessToken: r.accessToken, accessExpiresAt: new Date(r.accessExpiresAt).getTime(), refreshToken: r.refreshToken };
  }

  private async refresh(): Promise<void> {
    this.refreshing ??= (async () => {
      if (!this.tokens) throw new ApiError(401, 'UNAUTHENTICATED', 'Not logged in');
      const r = await this.raw('POST', '/auth/refresh', { json: { refreshToken: this.tokens.refreshToken }, auth: false });
      this.setTokens(r as { accessToken: string; accessExpiresAt: string; refreshToken: string });
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async raw(method: string, path: string, opts: { json?: unknown; body?: Buffer; headers?: Record<string, string>; auth?: boolean } = {}): Promise<unknown> {
    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': this.userAgent, ...(opts.headers ?? {}) };
    let body: Uint8Array | string | undefined;
    if (opts.body) {
      headers['content-type'] = 'application/octet-stream';
      body = new Uint8Array(opts.body.buffer, opts.body.byteOffset, opts.body.byteLength);
    } else if (opts.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.json);
    }
    if (opts.auth !== false && this.tokens) headers.authorization = `Bearer ${this.tokens.accessToken}`;
    let res: Response;
    try {
      res = await fetch(this.base + path, { method, headers, body, signal: AbortSignal.timeout(10 * 60_000) });
    } catch (err) {
      throw new ApiError(0, 'NETWORK', `Network error: ${(err as Error).message}`);
    }
    const text = await res.text();
    let data: unknown = undefined;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const e = (data as { error?: { code?: string; message?: string; details?: unknown } } | undefined)?.error;
      throw new ApiError(res.status, e?.code ?? `HTTP_${res.status}`, e?.message ?? res.statusText, e?.details);
    }
    return data;
  }

  /** Authenticated request with proactive refresh (<60 s to expiry) and one retry after a 401. */
  async request<T>(method: string, path: string, json?: unknown, extra: { body?: Buffer; headers?: Record<string, string> } = {}): Promise<T> {
    if (this.tokens && this.tokens.accessExpiresAt - Date.now() < 60_000) await this.refresh();
    try {
      return (await this.raw(method, path, { json, ...extra })) as T;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401 && this.tokens) {
        await this.refresh();
        return (await this.raw(method, path, { json, ...extra })) as T;
      }
      throw err;
    }
  }

  get<T>(path: string) {
    return this.request<T>('GET', path);
  }
  post<T>(path: string, json: unknown = {}) {
    return this.request<T>('POST', path, json);
  }
  putPart(sessionId: string, n: number, chunk: Buffer, sha256: string) {
    return this.request<{ partNumber: number; receivedParts: number; receivedBytes: number }>('PUT', `/uploads/${sessionId}/parts/${n}`, undefined, {
      body: chunk,
      headers: { [CHUNK_SHA256_HEADER]: sha256 },
    });
  }
}
