/**
 * Bulk upload engine: file discovery, sidecar metadata, whole-file SHA-256, resumable chunked transfer
 * (files × parts concurrency, per-chunk SHA-256, retry with exponential backoff), local state file.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { ALLOWED_UPLOAD_EXTENSIONS, type DeclaredUploadMetadata, type UploadInitResponse, type UploadSessionView } from '@ksp/shared';
import { ApiError, type KspClient } from './client.js';

export interface FileResult {
  path: string;
  size: number;
  status: 'REGISTERED' | 'QUARANTINED' | 'REJECTED' | 'PROCESSING' | 'UPLOADED' | 'FAILED' | 'SKIPPED';
  sessionId?: string;
  evidenceId?: string;
  evidenceNumber?: string | null;
  detail?: string;
  resumed?: boolean;
  /** The file had already been uploaded by an earlier run (nothing sent this time). */
  alreadyUploaded?: boolean;
  partsSent: number;
}

export interface UploadOptions {
  orgUnitId: string;
  batchId?: string;
  /** Preferred chunk size in bytes (server clamps to 5–64 MiB). */
  chunkSize?: number;
  fileConcurrency?: number;
  partConcurrency?: number;
  statePath: string;
  /** Hash the whole file before uploading so the server can verify end-to-end integrity (default true). */
  hashFiles?: boolean;
  /** Poll until each item is registered/quarantined (ms; 0 = don't wait). */
  waitMs?: number;
  pollIntervalMs?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  /** Defaults applied to every file (sidecar values win). */
  defaults?: DeclaredUploadMetadata;
  log?: (line: string) => void;
  /** Test hook invoked after every successful part upload. */
  onPart?: (file: string, n: number) => void | Promise<void>;
}

interface StateEntry {
  sessionId: string;
  size: number;
  mtimeMs: number;
  sha256?: string;
  evidenceId?: string;
  completed?: boolean;
}
type State = Record<string, StateEntry>;

const META_KEYS: Array<keyof DeclaredUploadMetadata> = [
  'title', 'description', 'category', 'officerBadge', 'officerId', 'deviceSerial', 'recordedAt', 'incidentAt', 'locationText', 'latitude', 'longitude', 'notes',
];

export function isVideoFile(p: string): boolean {
  return (ALLOWED_UPLOAD_EXTENSIONS as readonly string[]).includes(extname(p).toLowerCase());
}

/** Expand files and folders (recursively) into a sorted list of candidate video files. */
export async function collectFiles(inputs: string[]): Promise<{ files: string[]; skipped: string[] }> {
  const files = new Set<string>();
  const skipped: string[] = [];
  async function walk(p: string) {
    const st = await stat(p);
    if (st.isDirectory()) {
      for (const e of await readdir(p, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        const child = join(p, e.name);
        if (e.isDirectory()) await walk(child);
        else if (e.isFile() && isVideoFile(child)) files.add(resolve(child));
      }
    } else if (st.isFile()) {
      if (isVideoFile(p)) files.add(resolve(p));
      else skipped.push(resolve(p));
    }
  }
  for (const i of inputs) await walk(i);
  return { files: [...files].sort(), skipped };
}

/** `<file>.json` or `<file without ext>.json` sidecar with declared metadata. */
export function readSidecar(file: string): DeclaredUploadMetadata {
  const candidates = [`${file}.json`, file.slice(0, file.length - extname(file).length) + '.json'];
  for (const c of candidates) {
    if (!existsSync(c)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(c, 'utf8'));
    } catch (err) {
      throw new Error(`Invalid sidecar JSON ${c}: ${(err as Error).message}`);
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Sidecar ${c} must contain a JSON object`);
    const out: Record<string, unknown> = {};
    for (const k of META_KEYS) if ((raw as Record<string, unknown>)[k] !== undefined && (raw as Record<string, unknown>)[k] !== '') out[k] = (raw as Record<string, unknown>)[k];
    return out as DeclaredUploadMetadata;
  }
  return {};
}

export async function sha256OfFile(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path, { highWaterMark: 4 * 1024 * 1024 })) h.update(chunk as Buffer);
  return h.digest('hex');
}

function loadState(path: string): State {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as State;
  } catch {
    return {};
  }
}

function saveState(path: string, s: State) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, path);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(what: string, fn: () => Promise<T>, o: { maxAttempts: number; baseDelayMs: number; log: (s: string) => void }): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const retryable = err instanceof ApiError ? err.retryable : true;
      if (!retryable || attempt >= o.maxAttempts) throw err;
      const delay = Math.min(60_000, o.baseDelayMs * 2 ** (attempt - 1)) * (0.75 + Math.random() * 0.5);
      o.log(`  retry ${what} (attempt ${attempt + 1}/${o.maxAttempts}) in ${Math.round(delay)} ms: ${(err as Error).message}`);
      await sleep(delay);
    }
  }
}

async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    for (let it = queue.shift(); it !== undefined; it = queue.shift()) await fn(it);
  }));
}

/**
 * The result fields derived from the server's current view. Every field is always present (possibly undefined) so
 * that Object.assign replaces a previous value — a registered file never keeps an old "awaiting validation" detail
 * (FN-22).
 */
export function outcomeOf(v: UploadSessionView): Required<Pick<FileResult, 'status'>> & Pick<FileResult, 'detail' | 'evidenceId' | 'evidenceNumber'> {
  const ev = v.evidence;
  if (v.status !== 'COMPLETED') return { status: 'FAILED', detail: `upload ${v.status}${v.error ? `: ${v.error}` : ''}`, evidenceId: undefined, evidenceNumber: undefined };
  if (!ev) return { status: 'UPLOADED', detail: 'awaiting validation', evidenceId: undefined, evidenceNumber: undefined };
  if (ev.status === 'REGISTERED') return { status: 'REGISTERED', evidenceId: ev.id, evidenceNumber: ev.evidenceNumber, detail: undefined };
  if (ev.status === 'QUARANTINED') return { status: 'QUARANTINED', evidenceId: ev.id, evidenceNumber: undefined, detail: ev.statusReason ?? undefined };
  if (ev.status === 'REJECTED') return { status: 'REJECTED', evidenceId: ev.id, evidenceNumber: undefined, detail: ev.statusReason ?? undefined };
  return { status: 'PROCESSING', evidenceId: ev.id, evidenceNumber: undefined, detail: `evidence ${ev.status}` };
}

export async function uploadFiles(client: KspClient, files: string[], opts: UploadOptions): Promise<FileResult[]> {
  const log = opts.log ?? (() => undefined);
  const retry = { maxAttempts: opts.maxAttempts ?? 6, baseDelayMs: opts.baseDelayMs ?? 1000, log };
  const state = loadState(opts.statePath);
  const persist = () => saveState(opts.statePath, state);
  const results: FileResult[] = [];

  await pool(files, opts.fileConcurrency ?? 3, async (file) => {
    const st = await stat(file);
    const key = `${file}|${st.size}|${Math.round(st.mtimeMs)}`;
    const r: FileResult = { path: file, size: st.size, status: 'FAILED', partsSent: 0 };
    results.push(r);
    try {
      let entry = state[key];
      let session: UploadSessionView | null = null;
      if (entry) {
        try {
          session = await client.get<UploadSessionView>(`/uploads/${entry.sessionId}`);
        } catch (err) {
          if (!(err instanceof ApiError && err.status === 404)) throw err;
        }
        if (session && session.status === 'COMPLETED') {
          Object.assign(r, { sessionId: session.id, ...outcomeOf(session) });
          if (entry.completed) {
            r.alreadyUploaded = true;
            log(`= ${basename(file)}: already uploaded (${r.status})`);
            return;
          }
        } else if (!session || !['INITIATED', 'UPLOADING'].includes(session.status)) {
          session = null; // aborted / expired / failed / unknown -> start over
          delete state[key];
          entry = undefined;
        } else {
          r.resumed = true;
          log(`~ ${basename(file)}: resuming (${session.receivedParts?.length ?? 0}/${session.totalChunks} parts on server)`);
        }
      }
      if (!session) {
        const metadata = { ...(opts.defaults ?? {}), ...readSidecar(file) };
        const sha256 = opts.hashFiles === false ? undefined : await sha256OfFile(file);
        const init = await withRetry('initiate', () => client.post<UploadInitResponse>('/uploads', {
          batchId: opts.batchId, orgUnitId: opts.orgUnitId, filename: basename(file), size: st.size, sha256, metadata, chunkSize: opts.chunkSize,
        }), retry);
        entry = { sessionId: init.id, size: st.size, mtimeMs: Math.round(st.mtimeMs), sha256 };
        state[key] = entry;
        persist();
        session = await client.get<UploadSessionView>(`/uploads/${init.id}`);
        log(`+ ${basename(file)}: ${init.totalChunks} × ${(init.chunkSize / 1048576).toFixed(0)} MiB`);
      }
      r.sessionId = session.id;
      if (session.status !== 'COMPLETED') {
        const have = new Set(session.receivedParts ?? []);
        const missing = Array.from({ length: session.totalChunks }, (_, i) => i + 1).filter((n) => !have.has(n));
        const fh = await open(file, 'r');
        try {
          await pool(missing, opts.partConcurrency ?? 3, async (n) => {
            const start = (n - 1) * session!.chunkSize;
            const len = Math.min(session!.chunkSize, st.size - start);
            const buf = Buffer.alloc(len);
            const { bytesRead } = await fh.read(buf, 0, len, start);
            if (bytesRead !== len) throw new Error(`short read at part ${n}`);
            const sha = createHash('sha256').update(buf).digest('hex');
            await withRetry(`part ${n}`, () => client.putPart(session!.id, n, buf, sha), retry);
            r.partsSent++;
            await opts.onPart?.(file, n);
          });
        } finally {
          await fh.close();
        }
        const done = await withRetry('complete', () => client.post<UploadSessionView>(`/uploads/${session!.id}/complete`), retry);
        Object.assign(r, outcomeOf(done));
        entry!.completed = true;
        entry!.evidenceId = done.evidence?.id;
        persist();
        log(`✓ ${basename(file)}: uploaded (${r.partsSent} parts sent)`);
      } else {
        entry!.completed = true;
        persist();
      }
    } catch (err) {
      r.status = 'FAILED';
      r.detail = err instanceof ApiError ? `${err.code}: ${err.message}` : (err as Error).message;
      log(`✗ ${basename(file)}: ${r.detail}`);
    }
  });

  // Optionally wait for validation/registration results.
  const waitMs = opts.waitMs ?? 0;
  if (waitMs > 0) {
    const until = Date.now() + waitMs;
    const pending = () => results.filter((r) => r.sessionId && (r.status === 'UPLOADED' || r.status === 'PROCESSING'));
    while (pending().length && Date.now() < until) {
      await sleep(opts.pollIntervalMs ?? 3000);
      for (const r of pending()) {
        try {
          Object.assign(r, outcomeOf(await client.get<UploadSessionView>(`/uploads/${r.sessionId}`)));
        } catch (err) {
          log(`  status check failed for ${basename(r.path)}: ${(err as Error).message}`);
        }
      }
    }
  }
  // Final refresh so the summary shows the server's CURRENT status of every uploaded file (FN-22), also with --no-wait.
  for (const r of results.filter((x) => x.sessionId && x.status !== 'FAILED')) {
    try {
      Object.assign(r, outcomeOf(await client.get<UploadSessionView>(`/uploads/${r.sessionId}`)));
    } catch (err) {
      log(`  status check failed for ${basename(r.path)}: ${(err as Error).message}`);
    }
  }
  return results.sort((a, b) => a.path.localeCompare(b.path));
}

/** Detail column: the current server detail, marked when nothing had to be uploaded this run. */
export function detailOf(r: FileResult): string {
  return [r.detail, r.alreadyUploaded ? 'already uploaded' : null].filter(Boolean).join(' · ');
}

export function formatBytes(n: number): string {
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
}

export function summaryTable(results: FileResult[]): string {
  const rows = [['File', 'Size', 'Status', 'Evidence #', 'Detail'], ...results.map((r) => [basename(r.path), formatBytes(r.size), r.status + (r.resumed ? ' (resumed)' : ''), r.evidenceNumber ?? '', detailOf(r).slice(0, 80)])];
  const w = rows[0]!.map((_, c) => Math.max(...rows.map((row) => row[c]!.length)));
  const line = (row: string[]) => row.map((v, c) => v.padEnd(w[c]!)).join('  ').trimEnd();
  return [line(rows[0]!), w.map((x) => '-'.repeat(x)).join('  '), ...rows.slice(1).map(line)].join('\n');
}
