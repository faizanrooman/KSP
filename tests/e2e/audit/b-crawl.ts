/**
 * UI audit B crawler (not part of the Playwright suite): signs in as a user, visits pages at several viewports,
 * takes full-page screenshots and records layout problems (horizontal page scroll, elements past the viewport,
 * clipped text), console errors and failed API requests.
 *
 *   npx tsx tests/e2e/audit/b-crawl.ts <user> <out-dir> <pages.json> [widths=1920,1366,1024,768]
 *
 * pages.json: [{ "name": "cases", "path": "/cases" }, ...]. Screenshots: <out-dir>/<width>/<name>.png, report:
 * <out-dir>/report-<user>.json. Needs the E2E MFA state (tests/e2e/.state/mfa.json) for MFA users.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Page } from '@playwright/test';
import { readMfa, totpFor } from '../lib/auth';
import { BASE_URL, DEV_PASSWORD } from '../lib/env';

const [user = 'admin', outDir = '.local/ui-audit-b', pagesFile = '', widthsArg = '1920,1366,1024,768'] = process.argv.slice(2);
const HEIGHT: Record<number, number> = { 1920: 1080, 1366: 768, 1024: 768, 768: 1024, 390: 844 };
const pages = JSON.parse(readFileSync(pagesFile, 'utf8')) as Array<{ name: string; path: string; public?: boolean }>;
const widths = widthsArg.split(',').map(Number);

async function login(page: Page) {
  await page.goto(`${BASE_URL}/login`);
  await page.getByLabel('Username').fill(user);
  await page.getByLabel('Password').fill(process.env.PW ?? DEV_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const mfa = readMfa()[user];
  if (mfa) {
    await page.getByLabel('Verification code').fill(totpFor(mfa.secret));
    await page.getByRole('button', { name: 'Verify' }).click();
  }
  await page.getByRole('button', { name: 'Sign out' }).waitFor({ timeout: 30_000 });
}

// Plain JS string: tsx/esbuild would inject `__name` helpers into a serialised function.
const MEASURE = `(() => {
  const vw = document.documentElement.clientWidth;
  const out = { hscroll: document.documentElement.scrollWidth - vw, past: [], clipped: [] };
  const desc = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + '.' + String(el.getAttribute('class') || '').split(' ').slice(0, 3).join('.') + ' "' + (el.textContent || '').trim().slice(0, 40) + '"';
  const inScroller = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (p === document.body || p === document.documentElement) break;
      if (/(auto|scroll|hidden)/.test(getComputedStyle(p).overflowX)) return true;
    }
    return false;
  };
  for (const el of Array.from(document.querySelectorAll('body *'))) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (r.right > vw + 1 && !inScroller(el) && out.past.length < 8) out.past.push(desc(el) + ' right=' + Math.round(r.right));
    const s = getComputedStyle(el);
    if (el.children.length === 0 && s.overflow === 'visible' && el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0 && s.display !== 'inline' && out.clipped.length < 8) out.clipped.push(desc(el) + ' ' + el.scrollWidth + '>' + el.clientWidth);
  }
  return out;
})()`;
async function measure(page: Page): Promise<{ hscroll: number; past: string[]; clipped: string[] }> {
  return page.evaluate(MEASURE);
}

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROME ?? '/opt/google/chrome/chrome' });
  const report: Record<string, unknown>[] = [];
  let state: Awaited<ReturnType<import('@playwright/test').BrowserContext['storageState']>> | undefined;
  for (const width of widths) {
    const ctx = await browser.newContext({ viewport: { width, height: HEIGHT[width] ?? 900 }, storageState: state });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text().slice(0, 200)}`));
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 200)}`));
    page.on('response', (r) => r.url().includes('/api/') && r.status() >= 400 && errors.push(`${r.status()} ${r.request().method()} ${r.url().replace(BASE_URL, '')}`));
    if (!state && pages.some((p) => !p.public)) {
      await login(page);
      state = await ctx.storageState();
    }
    mkdirSync(resolve(outDir, String(width)), { recursive: true });
    for (const p of pages) {
      errors.length = 0;
      await page.goto(`${BASE_URL}${p.path}`);
      await page.waitForLoadState('networkidle').catch(() => undefined);
      await page.waitForTimeout(400);
      const m = await measure(page);
      await page.screenshot({ path: resolve(outDir, String(width), `${p.name}.png`), fullPage: true });
      report.push({ width, page: p.name, url: page.url().replace(BASE_URL, ''), ...m, errors: [...errors] });
      const flag = m.hscroll > 0 || m.past.length || errors.length ? '!!' : 'ok';
      console.log(`${flag} ${width} ${p.name} hscroll=${m.hscroll} past=${m.past.length} clipped=${m.clipped.length} errors=${errors.length}`);
    }
    await ctx.close();
  }
  writeFileSync(resolve(outDir, `report-${user}.json`), JSON.stringify(report, null, 2));
  await browser.close();
}
void main();
