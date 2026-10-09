/**
 * PUBLIC external-recipient portal (/s/:token) — rendered without the app shell or a user session.
 * Access code -> share session (sessionStorage, sent as X-Share-Session) -> item list -> watermarked player.
 * No download/print controls unless the share allows them. Media URLs are short-lived API tokens.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useParams } from 'react-router';
import { Download, Loader2, Lock, Printer } from 'lucide-react';
import { ApiError, errorMessage, request } from '@/lib/api';
import { formatDateTime, formatDuration } from '@/lib/format';
import { Alert, Button, Field, Input } from '@/components/ui';
import type { PortalItem, PortalSession, PortalShare } from './types';
import { blockedText, openFailure, refreshDelayMs, storeKey } from './portal-helpers';


import { t as tr } from '@/lib/i18n';
function portal<T>(method: string, path: string, session: string | null, body?: unknown): Promise<T> {
  return request<T>(method, `/share-portal${path}`, { body, noRefresh: true, headers: session ? { 'x-share-session': session } : {} });
}

interface Playback {
  status: 'READY' | 'PREPARING' | 'PROCESSING';
  mp4Url?: string;
  expiresAt?: string;
  watermarked?: boolean;
  message?: string;
}

export function SharePortalPage() {
  const { token = '' } = useParams<{ token: string }>();
  const [session, setSession] = useState<string | null>(() => sessionStorage.getItem(storeKey(token)));
  const [share, setShare] = useState<PortalShare | null>(null);
  const [items, setItems] = useState<PortalItem[]>([]);
  const [selected, setSelected] = useState<PortalItem | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!session);

  const endSession = useCallback((msg?: string) => {
    sessionStorage.removeItem(storeKey(token));
    setSession(null);
    setShare(null);
    setSelected(null);
    if (msg) setFatal(msg);
  }, [token]);

  useEffect(() => {
    if (!session || share) return;
    portal<{ share: PortalShare; items: PortalItem[] }>('GET', '/session', session)
      .then((r) => { setShare(r.share); setItems(r.items); setSelected(r.items[0] ?? null); })
      .catch((e) => endSession(e instanceof ApiError && e.status === 410 ? e.message : undefined))
      .finally(() => setLoading(false));
  }, [session, share, endSession]);

  const onOpened = (r: PortalSession) => {
    sessionStorage.setItem(storeKey(token), r.sessionToken);
    setSession(r.sessionToken);
    setShare(r.share);
    setItems(r.items);
    setSelected(r.items[0] ?? null);
    setFatal(null);
  };

  return (
    <div className="min-h-screen bg-ink-50">
      <header className="border-b border-ink-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center gap-2 px-4 py-3">
          <img src="/brand/ksp-emblem.png" alt="" className="h-9 w-auto" />
          <div>
            <div className="text-sm font-semibold text-ink-900">{tr('Karnataka State Police — Secure Evidence Share')}</div>
            <div className="text-xs text-ink-600">{tr('Access is logged. Redistribution is prohibited.')}</div>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-ink-600"><Loader2 className="h-4 w-4 animate-spin" aria-hidden />{' '}{tr('Loading…')}</div>
        ) : !session || !share ? (
          <CodeForm token={token} onOpened={onOpened} notice={fatal} />
        ) : (
          <Viewer share={share} items={items} selected={selected} onSelect={setSelected} session={session} onEnded={endSession} />
        )}
      </main>
    </div>
  );
}

function CodeForm({ token, onOpened, notice }: { token: string; onOpened: (r: PortalSession) => void; notice: string | null }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<string | null>(notice);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onOpened(await portal<PortalSession>('POST', '/open', null, { token, code: code.trim() }));
    } catch (err) {
      const f = openFailure(err);
      if (f.kind === 'blocked') setBlocked(f.message);
      else setError(f.message);
    } finally {
      setBusy(false);
    }
  };
  if (blocked) return <Alert tone="red" title={tr('This share is not available')}>{blockedText(blocked)}</Alert>;
  return (
    <form onSubmit={submit} className="mx-auto max-w-sm space-y-4 rounded-lg border border-ink-200 bg-white p-6 shadow-sm">
      <div className="flex items-center gap-2 text-ink-900"><Lock className="h-5 w-5" aria-hidden /><h1 className="text-lg font-semibold">{tr('Enter your access code')}</h1></div>
      <p className="text-sm text-ink-600">{tr('The access code was sent to you separately from this link.')}</p>
      <Field label={tr('Access code')} htmlFor="sp-code">
        <Input id="sp-code" inputMode="numeric" autoComplete="one-time-code" autoFocus value={code} onChange={(e) => setCode(e.target.value.replace(/\s/g, ''))} className="mono text-lg tracking-widest" />
      </Field>
      {error && <Alert tone="red">{error}</Alert>}
      <Button type="submit" className="w-full" loading={busy} disabled={code.length < 4}>{tr('Open')}</Button>
    </form>
  );
}

function Viewer({ share, items, selected, onSelect, session, onEnded }: { share: PortalShare; items: PortalItem[]; selected: PortalItem | null; onSelect: (i: PortalItem) => void; session: string; onEnded: (msg?: string) => void }) {
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-ink-200 bg-white p-4 text-sm">
        <div className="font-medium text-ink-900">{tr('Shared with')}{' '}{share.recipient.name}{share.recipient.organisation ? `, ${share.recipient.organisation}` : ''}</div>
        <div className="text-ink-700">{tr('Purpose:')}{' '}{share.purpose}</div>
        <div className="mt-1 text-xs text-ink-600">
          {tr('Shared by')}{' '}{[share.sharedBy.rank, share.sharedBy.name].filter(Boolean).join(' ')} ({share.sharedBy.unit}{tr(') · available until')}{' '}{formatDateTime(share.expiresAt)}
          {share.maxViews ? tr(' · view {viewCount} of {maxViews}', { viewCount: share.viewCount, maxViews: share.maxViews }) : ''}
          {share.permissions.watermark ? tr(' · video is watermarked with your identity') : ''}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-[16rem_1fr]">
        <nav aria-label={tr('Shared items')} className="rounded-lg border border-ink-200 bg-white">
          <ul className="divide-y divide-ink-100">
            {items.map((i) => (
              <li key={i.evidenceId}>
                <button type="button" onClick={() => onSelect(i)} aria-current={selected?.evidenceId === i.evidenceId ? 'true' : undefined}
                  className={`w-full px-3 py-2 text-left text-sm hover:bg-brand-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${selected?.evidenceId === i.evidenceId ? 'bg-brand-50' : ''}`}>
                  <div className="mono text-xs">{i.evidenceNumber}</div>
                  <div className="text-ink-700">{i.title ?? tr('Untitled')}</div>
                  <div className="text-xs text-ink-500">{formatDuration(i.durationMs)}{' '}{tr('· recorded')}{' '}{formatDateTime(i.recordedAt)}</div>
                </button>
              </li>
            ))}
          </ul>
        </nav>
        {selected ? <ItemPlayer key={selected.evidenceId} item={selected} share={share} session={session} onEnded={onEnded} /> : <Alert>{tr('No items are available in this share.')}</Alert>}
      </div>
    </div>
  );
}

function ItemPlayer({ item, share, session, onEnded }: { item: PortalItem; share: PortalShare; session: string; onEnded: (msg?: string) => void }) {
  const [pb, setPb] = useState<Playback | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'download' | 'original' | 'print' | null>(null);
  const video = useRef<HTMLVideoElement>(null);

  const handle = useCallback((e: unknown) => {
    if (e instanceof ApiError && (e.status === 401 || e.status === 410)) onEnded(e.status === 410 ? e.message : undefined);
    else setError(errorMessage(e));
  }, [onEnded]);

  const load = useCallback(async () => {
    try {
      const r = await portal<Playback>('GET', `/items/${item.evidenceId}/playback`, session);
      setPb((prev) => {
        // Token refresh: keep the playback position.
        if (prev?.mp4Url && r.mp4Url && video.current) {
          const t = video.current.currentTime;
          const paused = video.current.paused;
          requestAnimationFrame(() => {
            if (!video.current) return;
            video.current.currentTime = t;
            if (!paused) void video.current.play();
          });
        }
        return r;
      });
    } catch (e) {
      handle(e);
    }
  }, [item.evidenceId, session, handle]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const ms = refreshDelayMs(pb);
    if (ms === null) return;
    const t = setTimeout(() => void load(), ms);
    return () => clearTimeout(t);
  }, [pb, load]);

  const download = async (variant: 'watermarked' | 'original') => {
    setBusy(variant === 'original' ? 'original' : 'download');
    try {
      const r = await portal<{ status: string; url?: string; message?: string }>('GET', `/items/${item.evidenceId}/download-link?variant=${variant}`, session);
      if (!r.url) { setError(r.message ?? 'The file is being prepared; try again shortly.'); return; }
      const a = document.createElement('a');
      a.href = r.url;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      handle(e);
    } finally {
      setBusy(null);
    }
  };

  const print = async () => {
    // Opened synchronously (user gesture) so pop-up blockers allow it; filled once the still is fetched.
    const w = window.open('', '_blank');
    setBusy('print');
    try {
      const t = Math.round((video.current?.currentTime ?? 0) * 1000);
      const res = await fetch(`/api/v1/share-portal/items/${item.evidenceId}/print?timeMs=${t}`, { headers: { 'x-share-session': session } });
      if (!res.ok) throw new ApiError(res.status, 'PRINT_FAILED', res.status === 403 ? 'Printing is not allowed for this share' : 'The still could not be prepared');
      const url = URL.createObjectURL(await res.blob());
      if (w) {
        w.document.title = `${item.evidenceNumber ?? ''} — watermarked still`;
        const img = w.document.createElement('img');
        img.src = url;
        img.style.maxWidth = '100%';
        img.onload = () => w.print();
        const cap = w.document.createElement('p');
        cap.textContent = `${item.evidenceNumber ?? ''} at ${formatDuration(t)} — shared with ${share.recipient.name ?? ''}; printed ${new Date().toISOString()}. COPY - NOT ORIGINAL.`;
        w.document.body.append(img, cap);
      }
    } catch (e) {
      w?.close();
      handle(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-label={tr('Evidence {value}', { value: item.evidenceNumber ?? '' })} className="space-y-3">
      <div className="overflow-hidden rounded-lg bg-black">
        {pb?.status === 'READY' && pb.mp4Url ? (
          <video
            ref={video}
            src={pb.mp4Url}
            controls
            playsInline
            preload="metadata"
            controlsList={share.permissions.allowDownload ? 'noremoteplayback' : 'nodownload noremoteplayback noplaybackrate'}
            disablePictureInPicture
            onContextMenu={(e) => e.preventDefault()}
            onError={() => void load()}
            className="aspect-video w-full"
          >
            <track kind="captions" />
          </video>
        ) : (
          <div className="flex aspect-video items-center justify-center gap-2 text-sm text-ink-200">
            <Loader2 className="h-5 w-5 animate-spin" aria-hidden /> {pb?.message ?? tr('Loading video…')}
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {share.permissions.allowDownload && <Button variant="secondary" icon={<Download className="h-4 w-4" />} loading={busy === 'download'} onClick={() => void download('watermarked')}>{tr('Download')}{' '}{share.permissions.watermark ? tr('watermarked copy') : tr('copy')}</Button>}
        {share.permissions.allowOriginal && <Button variant="secondary" icon={<Download className="h-4 w-4" />} loading={busy === 'original'} onClick={() => void download('original')}>{tr('Download original')}</Button>}
        {share.permissions.allowPrint && <Button variant="secondary" icon={<Printer className="h-4 w-4" />} loading={busy === 'print'} disabled={pb?.status !== 'READY'} onClick={() => void print()}>{tr('Print current frame')}</Button>}
        <span className="text-xs text-ink-500">{tr('Every view, download and print is recorded.')}</span>
      </div>
      {error && <Alert tone="red">{error}</Alert>}
    </section>
  );
}
