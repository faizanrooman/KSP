/**
 * Typed fetch wrapper for the KSP API.
 *  - cookies carry the session (httpOnly); the CSRF double-submit header is added to unsafe requests;
 *  - on 401 it performs ONE silent refresh (rotating refresh token) and retries;
 *  - errors are thrown as ApiError with the server's error code.
 */
import { API_PREFIX, CSRF_COOKIE, CSRF_HEADER, type ApiErrorBody } from '@ksp/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type Query = Record<string, string | number | boolean | null | undefined | Array<string | number>>;

function readCookie(name: string): string | undefined {
  return document.cookie
    .split('; ')
    .find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

export function buildUrl(path: string, query?: Query): string {
  const url = new URL(`${API_PREFIX}${path}`, window.location.origin);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, String(x)));
      else url.searchParams.set(k, String(v));
    }
  }
  return url.pathname + url.search;
}

/**
 * Idle timeout (tender req 67): only requests that follow real user activity keep the session alive. Requests made
 * more than ACTIVE_WINDOW_MS after the last click / key / scroll / touch (dashboard auto-refresh, notification polling,
 * job progress polling …) carry BACKGROUND_HEADER and the API does not extend the idle deadline for them.
 * Work the user started and is waiting for (an upload in progress, a video playing) calls markUserActivity().
 */
export const BACKGROUND_HEADER = 'x-ksp-background';
const ACTIVE_WINDOW_MS = 60_000;
let lastActivity = Date.now();
export function markUserActivity(): void {
  lastActivity = Date.now();
}
if (typeof window !== 'undefined') {
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const) window.addEventListener(ev, markUserActivity, { passive: true, capture: true });
}
const isBackground = () => Date.now() - lastActivity > ACTIVE_WINDOW_MS;

let refreshing: Promise<boolean> | null = null;
async function refreshSession(): Promise<boolean> {
  refreshing ??= fetch(`${API_PREFIX}/auth/refresh`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', [CSRF_HEADER]: readCookie(CSRF_COOKIE) ?? '', ...(isBackground() ? { [BACKGROUND_HEADER]: '1' } : {}) },
    body: '{}',
  })
    .then((r) => r.ok)
    .catch(() => false)
    .finally(() => {
      setTimeout(() => (refreshing = null), 0);
    });
  return refreshing;
}

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  /** Raw body (e.g. upload chunk). */
  raw?: BodyInit;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Do not attempt refresh on 401 (auth endpoints). */
  noRefresh?: boolean;
}

export async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json', ...(isBackground() ? { [BACKGROUND_HEADER]: '1' } : {}), ...(opts.headers ?? {}) };
  let body: BodyInit | undefined;
  if (opts.raw !== undefined) {
    body = opts.raw;
  } else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  } else if (method !== 'GET' && method !== 'HEAD') {
    headers['content-type'] = 'application/json';
    body = '{}';
  }
  const send = () => {
    if (method !== 'GET' && method !== 'HEAD') headers[CSRF_HEADER] = readCookie(CSRF_COOKIE) ?? '';
    return fetch(buildUrl(path, opts.query), { method, headers, body, credentials: 'same-origin', signal: opts.signal });
  };
  let res = await send();
  if (res.status === 401 && !opts.noRefresh) {
    if (await refreshSession()) res = await send();
    if (res.status === 401) window.dispatchEvent(new CustomEvent('ksp:unauthenticated'));
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? safeJson(text) : undefined;
  if (!res.ok) {
    const err = (data as ApiErrorBody | undefined)?.error;
    throw new ApiError(res.status, err?.code ?? `HTTP_${res.status}`, err?.message ?? res.statusText, err?.details, err?.requestId);
  }
  return data as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export const api = {
  get: <T>(path: string, query?: Query, opts?: Omit<RequestOptions, 'query'>) => request<T>('GET', path, { ...opts, query }),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('POST', path, { ...opts, body }),
  put: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('PUT', path, { ...opts, body }),
  patch: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('PATCH', path, { ...opts, body }),
  delete: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('DELETE', path, { ...opts, body }),
};

/** Human-readable message for any thrown value. */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return 'Unexpected error';
}
