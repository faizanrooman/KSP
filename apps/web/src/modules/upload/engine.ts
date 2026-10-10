/**
 * Browser upload engine (framework-free): resumable chunked uploads against /api/v1/uploads.
 *
 *  - 3 files × 3 chunks in flight (configurable), per-chunk SHA-256 via WebCrypto (x-chunk-sha256);
 *  - retry with exponential backoff + jitter for network errors, 5xx, 429 and transit corruption;
 *  - pause / resume (in-flight chunk requests are aborted) and cancel (server session aborted);
 *  - resume after reload: session ids are kept in localStorage keyed by name+size+lastModified; when the
 *    same file is added again the engine asks the server which parts it has and sends only the rest;
 *  - after completion, polls until the item is REGISTERED or QUARANTINED.
 */
import { ALLOWED_UPLOAD_EXTENSIONS, CHUNK_SHA256_HEADER, parseStatusReason, type DeclaredUploadMetadata, type UploadInitResponse, type UploadSessionView } from '@ksp/shared';
import { ApiError, api, markUserActivity, request } from '@/lib/api';

export type ItemState =
  | 'ready' | 'hashing' | 'uploading' | 'paused' | 'completing' | 'processing' | 'registered' | 'quarantined' | 'rejected' | 'failed' | 'cancelled';

export interface UploadItem {
  key: string;
  file: File;
  relativePath: string;
  metadata: DeclaredUploadMetadata;
  state: ItemState;
  sessionId?: string;
  totalChunks?: number;
  chunkSize?: number;
  doneParts: number;
  bytesDone: number;
  speedBps: number;
  resumed: boolean;
  error?: string;
  evidenceId?: string;
  evidenceNumber?: string | null;
  reasonCode?: string | null;
  reasonMessage?: string | null;
  attempts: number;
}

const STORE_PREFIX = 'ksp-upload:';
const FINAL: ItemState[] = ['registered', 'quarantined', 'rejected', 'failed', 'cancelled'];
const ACTIVE: ItemState[] = ['hashing', 'uploading', 'completing'];

export function fileKey(f: File): string {
  return `${f.name}|${f.size}|${f.lastModified}`;
}

export function isAcceptedFile(name: string): boolean {
  const i = name.lastIndexOf('.');
  return i > 0 && (ALLOWED_UPLOAD_EXTENSIONS as readonly string[]).includes(name.slice(i).toLowerCase());
}

interface Stored { sessionId: string; savedAt: number; name: string; size: number }
function storeGet(key: string): Stored | null {
  try {
    const raw = localStorage.getItem(STORE_PREFIX + key);
    return raw ? (JSON.parse(raw) as Stored) : null;
  } catch {
    return null;
  }
}
function storeSet(key: string, v: Stored) {
  try {
    localStorage.setItem(STORE_PREFIX + key, JSON.stringify(v));
  } catch {
    /* storage full / disabled: resume across reloads unavailable */
  }
}
function storeDel(key: string) {
  try {
    localStorage.removeItem(STORE_PREFIX + key);
  } catch {
    /* ignore */
  }
}

/** Unfinished uploads remembered from a previous page session (the user must re-add the files). */
export function rememberedUploads(): Array<Stored & { key: string }> {
  const out: Array<Stored & { key: string }> = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith(STORE_PREFIX)) continue;
      const v = storeGet(k.slice(STORE_PREFIX.length));
      if (v) out.push({ ...v, key: k.slice(STORE_PREFIX.length) });
    }
  } catch {
    /* ignore */
  }
  return out.sort((a, b) => b.savedAt - a.savedAt);
}
export function forgetUpload(key: string) {
  storeDel(key);
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      rej(new DOMException('aborted', 'AbortError'));
    }, { once: true });
  });

function retryable(err: unknown): boolean {
  if (err instanceof ApiError) return err.status >= 500 || err.status === 429 || err.status === 408 || err.code === 'CHUNK_HASH_MISMATCH';
  return !(err instanceof DOMException && err.name === 'AbortError');
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

export interface EngineOptions {
  fileConcurrency?: number;
  partConcurrency?: number;
  maxAttempts?: number;
  pollMs?: number;
}

export class UploadEngine {
  items: UploadItem[] = [];
  orgUnitId = '';
  batchId: string | undefined;
  private listeners = new Set<() => void>();
  private controllers = new Map<string, AbortController>();
  private running = new Set<string>();
  private samples = new Map<string, Array<{ t: number; b: number }>>();
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private notifyQueued = false;
  readonly opts: Required<EngineOptions>;

  constructor(opts: EngineOptions = {}) {
    this.opts = { fileConcurrency: 3, partConcurrency: 3, maxAttempts: 6, pollMs: 3000, ...opts };
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    if (this.notifyQueued) return;
    this.notifyQueued = true;
    queueMicrotask(() => {
      this.notifyQueued = false;
      this.items = [...this.items];
      for (const l of this.listeners) l();
    });
  }

  private patch(key: string, p: Partial<UploadItem>) {
    const i = this.items.findIndex((x) => x.key === key);
    if (i >= 0) {
      this.items[i] = { ...this.items[i]!, ...p };
      this.emit();
    }
  }

  get(key: string): UploadItem | undefined {
    return this.items.find((x) => x.key === key);
  }

  /** Add files; returns names rejected for their type. */
  add(files: Array<{ file: File; relativePath?: string }>, defaults: DeclaredUploadMetadata = {}): string[] {
    const rejected: string[] = [];
    for (const { file, relativePath } of files) {
      if (!isAcceptedFile(file.name)) {
        rejected.push(relativePath ?? file.name);
        continue;
      }
      const key = fileKey(file);
      if (this.items.some((x) => x.key === key)) continue;
      const remembered = storeGet(key);
      this.items.push({
        key, file, relativePath: relativePath ?? file.name, metadata: { ...defaults }, state: 'ready', doneParts: 0, bytesDone: 0, speedBps: 0,
        resumed: !!remembered, sessionId: remembered?.sessionId, attempts: 0,
      });
    }
    this.emit();
    return rejected;
  }

  remove(key: string) {
    const it = this.get(key);
    if (!it || ACTIVE.includes(it.state)) return;
    this.items = this.items.filter((x) => x.key !== key);
    this.emit();
  }

  setMetadata(key: string, m: DeclaredUploadMetadata) {
    const it = this.get(key);
    if (it && it.state === 'ready') this.patch(key, { metadata: m });
  }

  applyToAll(m: DeclaredUploadMetadata) {
    for (const it of this.items) if (it.state === 'ready') this.patch(it.key, { metadata: { ...it.metadata, ...m } });
  }

  start(orgUnitId: string, batchId?: string) {
    this.orgUnitId = orgUnitId;
    this.batchId = batchId;
    this.pump();
    this.pollTimer ??= setInterval(() => void this.poll(), this.opts.pollMs);
  }

  pause(key: string) {
    const it = this.get(key);
    if (!it || !['uploading', 'hashing', 'ready'].includes(it.state)) return;
    this.controllers.get(key)?.abort();
    this.patch(key, { state: 'paused', speedBps: 0 });
  }

  resume(key: string) {
    const it = this.get(key);
    if (!it || (it.state !== 'paused' && it.state !== 'failed')) return;
    this.patch(key, { state: 'ready', error: undefined });
    this.pump();
  }

  async cancel(key: string) {
    const it = this.get(key);
    if (!it || FINAL.includes(it.state) || it.state === 'processing' || it.state === 'completing') return;
    this.controllers.get(key)?.abort();
    this.patch(key, { state: 'cancelled', speedBps: 0 });
    storeDel(key);
    if (it.sessionId) await api.delete(`/uploads/${it.sessionId}`).catch(() => undefined);
  }

  pauseAll() {
    for (const it of this.items) if (['uploading', 'hashing', 'ready'].includes(it.state)) this.pause(it.key);
  }
  resumeAll() {
    for (const it of this.items) if (it.state === 'paused') this.patch(it.key, { state: 'ready' });
    this.pump();
  }

  dispose() {
    for (const c of this.controllers.values()) c.abort();
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  private pump() {
    if (!this.orgUnitId) return;
    for (const it of this.items) {
      if (this.running.size >= this.opts.fileConcurrency) break;
      if (it.state !== 'ready' || this.running.has(it.key)) continue;
      this.running.add(it.key);
      void this.run(it.key).finally(() => {
        this.running.delete(it.key);
        this.controllers.delete(it.key);
        this.pump();
      });
    }
  }

  private sample(key: string, bytes: number) {
    const now = performance.now();
    const arr = (this.samples.get(key) ?? []).filter((s) => now - s.t < 5000);
    arr.push({ t: now, b: bytes });
    this.samples.set(key, arr);
    const first = arr[0]!;
    const dt = (now - first.t) / 1000;
    return dt > 0.5 ? (bytes - first.b) / dt : 0;
  }

  private async withRetry<T>(key: string, fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (isAbort(err) || !retryable(err) || attempt >= this.opts.maxAttempts) throw err;
        this.patch(key, { attempts: (this.get(key)?.attempts ?? 0) + 1 });
        await sleep(Math.min(30_000, 1000 * 2 ** (attempt - 1)) * (0.75 + Math.random() * 0.5), signal);
      }
    }
  }

  private async run(key: string) {
    const ctrl = new AbortController();
    this.controllers.set(key, ctrl);
    const signal = ctrl.signal;
    const it = this.get(key)!;
    try {
      let session: UploadSessionView | null = null;
      if (it.sessionId) {
        try {
          session = await api.get<UploadSessionView>(`/uploads/${it.sessionId}`, undefined, { signal });
        } catch (err) {
          if (!(err instanceof ApiError && err.status === 404)) throw err;
        }
        if (session && session.status === 'COMPLETED') {
          this.applyOutcome(key, session);
          return;
        }
        if (!session || !['INITIATED', 'UPLOADING'].includes(session.status)) {
          session = null;
          storeDel(key);
        }
      }
      if (!session) {
        const init = await this.withRetry(key, () => api.post<UploadInitResponse>('/uploads', {
          batchId: this.batchId, orgUnitId: this.orgUnitId, filename: it.file.name, size: it.file.size, mimeType: it.file.type || undefined,
          metadata: cleanMetadata(it.metadata),
        }, { signal }), signal);
        storeSet(key, { sessionId: init.id, savedAt: Date.now(), name: it.file.name, size: it.file.size });
        session = await api.get<UploadSessionView>(`/uploads/${init.id}`, undefined, { signal });
      }
      const s = session;
      const have = new Set(s.receivedParts ?? []);
      let bytesDone = [...have].reduce((a, n) => a + partLen(it.file.size, s.chunkSize, n), 0);
      this.patch(key, { state: 'uploading', sessionId: s.id, totalChunks: s.totalChunks, chunkSize: s.chunkSize, doneParts: have.size, bytesDone, resumed: it.resumed || have.size > 0 });
      const queue = Array.from({ length: s.totalChunks }, (_, i) => i + 1).filter((n) => !have.has(n));
      let done = have.size;
      await Promise.all(Array.from({ length: Math.min(this.opts.partConcurrency, queue.length) }, async () => {
        for (let n = queue.shift(); n !== undefined; n = queue.shift()) {
          if (signal.aborted) throw new DOMException('aborted', 'AbortError');
          const start = (n - 1) * s.chunkSize;
          const blob = it.file.slice(start, Math.min(it.file.size, start + s.chunkSize));
          const buf = await blob.arrayBuffer();
          const sha = await sha256Hex(buf);
          const part = n;
          markUserActivity(); // an upload in progress is user work: it keeps the session alive (idle timeout)
          await this.withRetry(key, () => request('PUT', `/uploads/${s.id}/parts/${part}`, {
            raw: buf, headers: { 'content-type': 'application/octet-stream', [CHUNK_SHA256_HEADER]: sha }, signal,
          }), signal);
          done++;
          bytesDone += buf.byteLength;
          this.patch(key, { doneParts: done, bytesDone, speedBps: this.sample(key, bytesDone) });
        }
      }));
      this.patch(key, { state: 'completing', speedBps: 0 });
      const view = await this.withRetry(key, () => api.post<UploadSessionView>(`/uploads/${s.id}/complete`, undefined, { signal }), signal);
      storeDel(key);
      this.applyOutcome(key, view);
    } catch (err) {
      if (isAbort(err)) return; // paused or cancelled: state already set
      this.patch(key, { state: 'failed', speedBps: 0, error: err instanceof Error ? err.message : String(err) });
    }
  }

  private applyOutcome(key: string, v: UploadSessionView) {
    const ev = v.evidence;
    if (!ev || ev.status === 'RECEIVED' || ev.status === 'VALIDATING') {
      this.patch(key, { state: 'processing', sessionId: v.id, evidenceId: ev?.id, bytesDone: v.size, doneParts: v.totalChunks, totalChunks: v.totalChunks });
      return;
    }
    const r = parseStatusReason(ev.statusReason);
    const state: ItemState = ev.status === 'QUARANTINED' ? 'quarantined' : ev.status === 'REJECTED' ? 'rejected' : 'registered';
    this.patch(key, { state, sessionId: v.id, evidenceId: ev.id, evidenceNumber: ev.evidenceNumber, reasonCode: r.code, reasonMessage: r.message, bytesDone: v.size, doneParts: v.totalChunks, totalChunks: v.totalChunks });
  }

  private async poll() {
    for (const it of this.items.filter((x) => x.state === 'processing' && x.sessionId)) {
      try {
        this.applyOutcome(it.key, await api.get<UploadSessionView>(`/uploads/${it.sessionId}`));
      } catch {
        /* transient; next tick */
      }
    }
  }
}

function partLen(size: number, chunk: number, n: number): number {
  return Math.max(0, Math.min(chunk, size - (n - 1) * chunk));
}

export function cleanMetadata(m: DeclaredUploadMetadata): DeclaredUploadMetadata {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m)) {
    if (v === undefined || v === null || v === '') continue;
    if ((k === 'recordedAt' || k === 'incidentAt') && typeof v === 'string') {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) out[k] = d.toISOString();
      continue;
    }
    if ((k === 'latitude' || k === 'longitude') && typeof v === 'string') {
      const n = Number(v);
      if (Number.isFinite(n)) out[k] = n;
      continue;
    }
    out[k] = typeof v === 'string' ? v.trim() : v;
  }
  return out as DeclaredUploadMetadata;
}

/** Recursively read dropped folders (DataTransferItem.webkitGetAsEntry). */
export async function filesFromDrop(dt: DataTransfer): Promise<Array<{ file: File; relativePath: string }>> {
  const out: Array<{ file: File; relativePath: string }> = [];
  const entries = Array.from(dt.items)
    .map((i) => (i.kind === 'file' ? i.webkitGetAsEntry?.() : null))
    .filter((e): e is FileSystemEntry => !!e);
  if (!entries.length) return Array.from(dt.files).map((f) => ({ file: f, relativePath: f.name }));
  async function walk(e: FileSystemEntry, prefix: string): Promise<void> {
    if (e.isFile) {
      const file = await new Promise<File>((res, rej) => (e as FileSystemFileEntry).file(res, rej));
      out.push({ file, relativePath: prefix + file.name });
    } else if (e.isDirectory) {
      const reader = (e as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const c of batch) await walk(c, `${prefix}${e.name}/`);
      }
    }
  }
  for (const e of entries) await walk(e, '');
  return out;
}
