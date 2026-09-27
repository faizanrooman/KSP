import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export type MediaStatus = 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED' | 'UNSUPPORTED';

export interface PlaybackInfo {
  evidenceId: string;
  mediaStatus: MediaStatus;
  mediaError: string | null;
  progress: number;
  durationMs: number | null;
  /** Playback (proxy / HLS) frame rate — CFR; used for frame numbers and frame stepping. */
  frameRate: number | null;
  sourceFrameRate: number | null;
  sourceVfr: boolean | null;
  width: number | null;
  height: number | null;
  sourceWidth: number | null;
  sourceHeight: number | null;
  renditions: Array<{ name: string; width: number; height: number }>;
  hlsUrl: string | null;
  mp4Url: string | null;
  posterUrl: string | null;
  thumbnailUrl: string | null;
  spriteVttUrl: string | null;
  expiresAt: string | null;
}

export interface Snapshot {
  id: string;
  timeMs: number | null;
  frameNumber: number | null;
  frameTimeMs: number | null;
  fps: number | null;
  source: 'proxy' | 'original' | null;
  sha256: string | null;
  width: number | null;
  height: number | null;
  sizeBytes: number | null;
  createdAt: string;
  createdBy: { id: string; name: string | null } | null;
  url: string;
  downloadUrl: string;
}

export const playbackKey = (id: string) => ['media', 'playback', id] as const;
export const snapshotsKey = (id: string) => ['media', 'snapshots', id] as const;

/** Refresh the stream token this long before it expires (position is kept; see EvidencePlayer). */
const REFRESH_LEAD_MS = 60_000;

/**
 * Playback descriptor. While media is processing it polls every 3 s; once READY it refetches shortly
 * before the stream token expires so playback continues without interruption.
 */
export function usePlayback(evidenceId: string) {
  return useQuery({
    queryKey: playbackKey(evidenceId),
    queryFn: () => api.get<PlaybackInfo>(`/media/evidence/${evidenceId}/playback`),
    refetchOnWindowFocus: false,
    refetchInterval: (q) => {
      const d = q.state.data;
      if (!d) return false;
      if (d.mediaStatus === 'PENDING' || d.mediaStatus === 'PROCESSING') return 3000;
      if (d.mediaStatus === 'READY' && d.expiresAt) return Math.max(10_000, new Date(d.expiresAt).getTime() - Date.now() - REFRESH_LEAD_MS);
      return false;
    },
    refetchIntervalInBackground: true,
  });
}

export function useSnapshots(evidenceId: string, enabled = true) {
  return useQuery({
    queryKey: snapshotsKey(evidenceId),
    queryFn: () => api.get<{ items: Snapshot[]; total: number }>(`/media/evidence/${evidenceId}/snapshots`),
    enabled,
    // image tokens are valid for 15 minutes
    refetchInterval: 10 * 60_000,
  });
}

export function useCreateSnapshot(evidenceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { timeMs: number; source?: 'proxy' | 'original' }): Promise<Snapshot> => {
      const r = await api.post<Snapshot | { requestId: string; status: string }>(`/media/evidence/${evidenceId}/snapshots`, { timeMs: v.timeMs, source: v.source ?? 'proxy' });
      if (!('requestId' in r)) return r;
      // FN-8: the worker is busy — the API answered 202; poll the request until the frame is extracted.
      for (let i = 0; i < 120; i++) {
        await new Promise((res) => setTimeout(res, 1000));
        const s = await api.get<{ status: string; error: string | null; snapshot: Snapshot | null }>(`/media/snapshot-requests/${r.requestId}`);
        if (s.status === 'COMPLETED' && s.snapshot) return s.snapshot;
        if (s.status === 'FAILED') throw new Error(s.error ?? 'Frame could not be extracted at this position');
      }
      throw new Error('The snapshot is still being extracted; it will appear in the list when ready');
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: snapshotsKey(evidenceId) }),
  });
}

/** Replace the `t` query parameter of a media URL with a fresh token. */
export function withToken(url: string, token: string | null): string {
  if (!token) return url;
  const u = new URL(url, window.location.origin);
  if (!u.pathname.includes('/media/')) return url;
  u.searchParams.set('t', token);
  return u.origin === window.location.origin ? u.pathname + u.search + u.hash : u.toString();
}

export function tokenFrom(url: string | null): string | null {
  if (!url) return null;
  return new URL(url, window.location.origin).searchParams.get('t');
}

// ---------------------------------------------------------------------------------------------
export interface SpriteCue {
  startMs: number;
  endMs: number;
  url: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

function parseVttTime(s: string): number {
  const parts = s.trim().split(':');
  let sec = 0;
  for (const p of parts) sec = sec * 60 + Number(p);
  return Math.round(sec * 1000);
}

/** Parse a WebVTT thumbnail track (`image.jpg?t=…#xywh=x,y,w,h` cues); image URLs resolved against the VTT URL. */
export function parseSpriteVtt(text: string, vttUrl: string): SpriteCue[] {
  const base = new URL(vttUrl, window.location.origin);
  const out: SpriteCue[] = [];
  const blocks = text.replace(/\r/g, '').split(/\n\n+/);
  for (const b of blocks) {
    const lines = b.split('\n').filter(Boolean);
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0 || !lines[ti + 1]) continue;
    const [a, z] = lines[ti]!.split('-->');
    const ref = lines[ti + 1]!.trim();
    const m = /^(.*)#xywh=(\d+),(\d+),(\d+),(\d+)$/.exec(ref);
    if (!m || !a || !z) continue;
    const abs = new URL(m[1]!, base);
    out.push({ startMs: parseVttTime(a), endMs: parseVttTime(z.trim().split(/\s+/)[0]!), url: abs.pathname + abs.search, x: +m[2]!, y: +m[3]!, w: +m[4]!, h: +m[5]! });
  }
  return out;
}

export function cueAt(cues: SpriteCue[], ms: number): SpriteCue | null {
  let lo = 0;
  let hi = cues.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = cues[mid]!;
    if (ms < c.startMs) hi = mid - 1;
    else if (ms >= c.endMs) lo = mid + 1;
    else return c;
  }
  return cues.length ? cues[Math.max(0, Math.min(cues.length - 1, lo))]! : null;
}

export function frameOf(ms: number, fps: number | null): number | null {
  if (!fps) return null;
  return Math.max(0, Math.floor((ms / 1000) * fps + 1e-6));
}
