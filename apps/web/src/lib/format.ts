export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

/** mm:ss.mmm timecode for frame-accurate navigation. */
export function formatTimecode(ms: number): string {
  const total = Math.max(0, ms);
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const milli = Math.floor(total % 1000);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(milli).padStart(3, '0')}`;
}

const dtf = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
const df = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeZone: 'Asia/Kolkata' });
export function formatDateTime(v: string | Date | null | undefined): string {
  if (!v) return '—';
  const d = typeof v === 'string' ? new Date(v) : v;
  return Number.isNaN(d.getTime()) ? '—' : `${dtf.format(d)} IST`;
}
export function formatDate(v: string | Date | null | undefined): string {
  if (!v) return '—';
  const d = typeof v === 'string' ? new Date(v) : v;
  return Number.isNaN(d.getTime()) ? '—' : df.format(d);
}

export function shortHash(h: string | null | undefined, n = 12): string {
  return h ? `${h.slice(0, n)}…` : '—';
}

// Acronyms stay upper-case ("CCTNS", not "Cctns"; "MFA challenge passed", "AI results viewed") — UI-B-11.
const ACRONYMS = new Set(['AI', 'ANPR', 'API', 'BSA', 'CCTNS', 'CCTV', 'CSV', 'FIR', 'FSL', 'HLS', 'ID', 'IO', 'IP', 'JSON', 'KSP', 'MFA', 'OCR', 'PDF', 'SHA', 'SMS', 'TOTP', 'URL']);
export function titleCase(v: string): string {
  return v.toLowerCase().replace(/_/g, ' ').replace(/\b\w+/g, (w) => (ACRONYMS.has(w.toUpperCase()) ? w.toUpperCase() : w[0]!.toUpperCase() + w.slice(1)));
}

/** Parse "mm:ss.mmm", "hh:mm:ss.mmm", "ss.mmm" or plain milliseconds ("1234ms"). */
export function parseTimeInput(v: string): number | null {
  const s = v.trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?ms$/.test(s)) return Number(s.slice(0, -2));
  if (!/^[\d:.]+$/.test(s)) return null;
  const parts = s.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  let sec = 0;
  for (const p of parts) sec = sec * 60 + p;
  return Math.round(sec * 1000);
}
