/**
 * Helpers for the UI/UX audit crawler: generic layout checks that run on any page state and return findings.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { ROOT } from '../lib/env';

export const OUT_DIR = resolve(ROOT, '.local/ui-audit');

export const VIEWPORTS = [
  { name: '1920', width: 1920, height: 1080 },
  { name: '1366', width: 1366, height: 768 },
  { name: '1024', width: 1024, height: 768 },
  { name: '768', width: 768, height: 1024 },
] as const;

/** Route patterns of the SPA (apps/web/src/modules/*\/module.tsx). A link to anything else is dead. */
const ROUTES = [
  '/', '/login', '/admin/api-clients', '/admin/devices', '/admin/devices/:id', '/admin/integrations', '/admin/org', '/admin/roles', '/admin/roles/:id',
  '/admin/settings', '/admin/users', '/admin/users/:id', '/admin/users/new', '/ai/models', '/ai/watchlists', '/alerts', '/alerts/:id', '/alerts/rules',
  '/cases', '/cases/:id', '/compliance/audit', '/compliance/ledger', '/evidence', '/evidence/disposals', '/evidence/:id', '/evidence/:id/player',
  '/exports', '/exports/:id', '/exports/new', '/exports/verify', '/firs', '/firs/:id', '/notifications', '/profile', '/reports', '/retention/policies',
  '/review', '/search', '/shares', '/shares/:id', '/s/:token', '/system/health', '/upload', '/uploads', '/uploads/quarantine', '/workspaces', '/workspaces/:id',
].map((r) => new RegExp(`^${r.replace(/:[a-z]+/gi, '[^/]+')}/?$`));

export function isKnownRoute(path: string): boolean {
  return ROUTES.some((r) => r.test(path));
}

export interface Finding {
  page: string;
  viewport: string;
  kind: string;
  detail: string;
}

export class Recorder {
  findings: Finding[] = [];
  private current = { page: '', viewport: '' };
  constructor(readonly suite: string) {
    mkdirSync(resolve(OUT_DIR, suite), { recursive: true });
  }
  at(page: string, viewport: string): void {
    this.current = { page, viewport };
  }
  add(kind: string, detail: string): void {
    // The session probe before sign-in (401 on /auth/me and /auth/refresh) is expected, not a finding.
    if (/401 (GET|POST) \/api\/v1\/auth\/(me|refresh)|status of 401 \(Unauthorized\)/.test(detail)) return;
    const f = { ...this.current, kind, detail };
    if (!this.findings.some((x) => x.page === f.page && x.viewport === f.viewport && x.kind === f.kind && x.detail === f.detail)) this.findings.push(f);
  }
  /** Console errors, page errors and failed API requests of every page in the context. */
  watch(ctx: BrowserContext): void {
    const hook = (p: Page) => {
      p.on('console', (m) => m.type() === 'error' && this.add('console-error', m.text().slice(0, 300)));
      p.on('pageerror', (e) => this.add('page-error', e.message.slice(0, 300)));
      p.on('response', (r) => r.url().includes('/api/') && r.status() >= 400 && this.add('http-error', `${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`));
      p.on('requestfailed', (r) => !/aborted|cancel/i.test(r.failure()?.errorText ?? '') && this.add('request-failed', `${r.failure()?.errorText} ${new URL(r.url()).pathname}`));
    };
    ctx.pages().forEach(hook);
    ctx.on('page', hook);
  }
  shot(name: string): string {
    const p = resolve(OUT_DIR, this.suite, `${name.replace(/[^a-z0-9_.-]+/gi, '_')}.png`);
    return p;
  }
  save(): string {
    const file = resolve(OUT_DIR, this.suite, 'findings.json');
    writeFileSync(file, JSON.stringify(this.findings, null, 2));
    return file;
  }
}

/** Wait until spinners are gone and the network is quiet (best effort — polling pages never go fully idle). */
export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
  await page.getByText(/^Loading/).first().waitFor({ state: 'detached', timeout: 8_000 }).catch(() => undefined);
  await page.waitForTimeout(300);
}

/** Generic layout checks on the current page state. */
export async function layoutChecks(page: Page, rec: Recorder): Promise<void> {
  const r = await page.evaluate(() => {
    const out: Array<[string, string]> = [];
    const vw = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth > vw + 1) out.push(['horizontal-page-scroll', `scrollWidth ${document.documentElement.scrollWidth} > ${vw}`]);
    const desc = (el: Element) => {
      const t = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
      const cls = (el.getAttribute('class') ?? '').split(' ').slice(0, 4).join('.');
      return `<${el.tagName.toLowerCase()} ${cls}> "${t}"`;
    };
    const clipsX = (el: Element | null): boolean => {
      for (let a = el; a && a !== document.body; a = a.parentElement) {
        const s = getComputedStyle(a);
        if (['auto', 'scroll', 'hidden', 'clip'].includes(s.overflowX)) return true;
        if (s.position === 'fixed') return true;
      }
      return false;
    };
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') continue;
      const b = el.getBoundingClientRect();
      if (!b.width || !b.height) continue;
      // Content escaping the viewport that no scroll container catches.
      if (b.right > vw + 1 && !clipsX(el.parentElement) && !el.closest('.sr-only')) out.push(['off-viewport', `${desc(el)} right=${Math.round(b.right)}`]);
      // Text cut off (ellipsis/overflow hidden) without a tooltip to read it in full.
      const he = el as HTMLElement;
      if ((s.textOverflow === 'ellipsis' || s.overflowX === 'hidden') && he.scrollWidth > he.clientWidth + 1 && el.children.length === 0 && (el.textContent ?? '').trim()
        && !el.closest('[title]') && !el.closest('.sr-only')) out.push(['truncated-no-title', desc(el)]);
      // Text overflowing its own box visibly (overlapping neighbours).
      if (s.overflowX === 'visible' && el.children.length === 0 && (el.textContent ?? '').trim() && he.scrollWidth > he.clientWidth + 2 && s.display !== 'inline' && he.clientWidth > 0)
        out.push(['text-overflows-box', `${desc(el)} ${he.scrollWidth}>${he.clientWidth}`]);
    }
    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]')).map((a) => a.getAttribute('href') ?? '');
    const unnamed = Array.from(document.querySelectorAll('button, a[href]')).filter((b) => {
      const he = b as HTMLElement;
      return !(he.innerText.trim() || b.getAttribute('aria-label') || b.getAttribute('aria-labelledby') || b.getAttribute('title')) && he.offsetParent;
    }).map((b) => desc(b));
    return { out, links, unnamed };
  });
  for (const [k, d] of r.out.slice(0, 40)) rec.add(k, d);
  for (const u of r.unnamed) rec.add('unnamed-control', u);
  for (const href of r.links) {
    if (!href.startsWith('/') || href.startsWith('/api/')) continue;
    const path = href.split(/[?#]/)[0]!;
    if (!isKnownRoute(path)) rec.add('dead-link', href);
  }
}

/** Full-page screenshot plus viewport screenshot scrolled to the bottom; checks the sidebar stays visible. */
export async function capture(page: Page, rec: Recorder, name: string): Promise<void> {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: rec.shot(`${name}-full`), fullPage: true });
  const scrollable = await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight + 4);
  if (scrollable) {
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(200);
    await page.screenshot({ path: rec.shot(`${name}-bottom`) });
    const shell = await page.evaluate(() => {
      const aside = document.querySelector('aside');
      const nav = aside && getComputedStyle(aside).display !== 'none' ? aside.querySelector('nav[aria-label="Main"]') : null;
      const header = document.querySelector('header.sticky, body > div header');
      const vis = (el: Element | null) => (el && getComputedStyle(el).display !== 'none' ? el.getBoundingClientRect() : null);
      return { nav: vis(nav)?.top ?? null, navH: vis(nav)?.height ?? null, header: vis(header)?.top ?? null, vh: window.innerHeight };
    });
    if (shell.nav !== null && (Math.abs(shell.nav) > 1 || (shell.navH ?? 0) < shell.vh - 2)) rec.add('sidebar-not-pinned', JSON.stringify(shell));
    if (shell.header !== null && Math.abs(shell.header) > 1) rec.add('header-not-sticky', JSON.stringify(shell));
    await page.evaluate(() => window.scrollTo(0, 0));
  }
}
