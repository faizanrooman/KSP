/**
 * UI/UX audit crawl (screens of audit A): every page state at 4 viewports — full-page + scrolled-bottom screenshots,
 * generic layout checks (horizontal scroll, off-viewport content, truncation without tooltip, dead links, unnamed
 * controls, sticky shell), console errors and failed API requests. Output: .local/ui-audit/crawl/.
 */
import { test, type Browser, type Page } from '@playwright/test';
import { login, type DevUser } from '../lib/auth';
import { BASE_URL } from '../lib/env';
import { capture, layoutChecks, Recorder, settle, VIEWPORTS } from './lib';

async function signedIn(browser: Browser, user: DevUser, rec: Recorder): Promise<Page> {
  const ctx = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 1920, height: 1080 } });
  rec.watch(ctx);
  const page = await ctx.newPage();
  await login(page, user);
  return page;
}

async function get<T>(page: Page, path: string): Promise<T> {
  const r = await page.request.get(`/api/v1${path}`);
  return (await r.json()) as T;
}

test('crawl screens (audit A)', async ({ browser }) => {
  const rec = new Recorder(process.env.AUDIT_SUITE ?? 'crawl');
  const only = process.env.AUDIT_ONLY ? new RegExp(process.env.AUDIT_ONLY) : null;
  const vps = process.env.AUDIT_VP ? VIEWPORTS.filter((v) => process.env.AUDIT_VP!.split(',').includes(v.name)) : VIEWPORTS;
  const io = await signedIn(browser, 'io.meera', rec);
  const ev = await get<{ items: Array<{ id: string; mediaStatus: string; status: string }> }>(io, '/evidence?pageSize=50&sort=-created_at');
  const ready = ev.items.find((e) => e.mediaStatus === 'READY' && e.status !== 'DISPOSED') ?? ev.items[0];
  const ws = await get<{ items: Array<{ id: string }> }>(io, '/workspaces?pageSize=5');
  const evId = ready?.id ?? 'none';
  const wsId = ws.items[0]?.id ?? 'none';

  const screens: Array<[DevUser, string, string]> = [
    ['io.meera', 'dashboard', '/'],
    ['io.meera', 'evidence-list', '/evidence'],
    ...['overview', 'playback', 'snapshots', 'ai', 'notes', 'related', 'custody', 'integrity', 'lifecycle'].map((t): [DevUser, string, string] => ['io.meera', `evidence-${t}`, `/evidence/${evId}?tab=${t === 'overview' ? '' : t}`]),
    ['io.meera', 'player', `/evidence/${evId}/player`],
    ['op.cubbon', 'upload', '/upload'],
    ['op.cubbon', 'upload-history', '/uploads'],
    ['sup.kavya', 'quarantine', '/uploads/quarantine'],
    ['io.meera', 'search', '/search'],
    ['io.meera', 'search-results', '/search?q=e2e'],
    ['io.meera', 'workspaces', '/workspaces'],
    ...['evidence', 'compare', 'review', 'timeline', 'related', 'members'].map((t): [DevUser, string, string] => ['io.meera', `workspace-${t}`, `/workspaces/${wsId}?tab=${t}`]),
    ['sup.kavya', 'review-queue', '/review'],
    ['admin', 'ai-models', '/ai/models'],
    ['fa.naveen', 'watchlists', '/ai/watchlists'],
    ['io.meera', 'notifications', '/notifications'],
    ['io.meera', 'profile', '/profile'],
  ];
  const pages = new Map<DevUser, Page>([['io.meera', io]]);
  for (const [user, name, path] of screens) {
    if (only && !only.test(name)) continue;
    let page = pages.get(user);
    if (!page) {
      page = await signedIn(browser, user, rec);
      pages.set(user, page);
    }
    for (const vp of vps) {
      rec.at(name, vp.name);
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto(path);
      await settle(page);
      await layoutChecks(page, rec);
      await capture(page, rec, `${name}-${vp.name}`);
    }
  }
  console.log(`findings: ${rec.findings.length} → ${rec.save()}`);
});
