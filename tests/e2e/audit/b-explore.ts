/**
 * UI audit B exploratory driver (not part of the suite): opens dialogs, dropdowns and secondary states on the
 * audit-B screens and screenshots them (viewport, not full page) into <out>/<width>/x-<name>.png.
 *   npx tsx tests/e2e/audit/b-explore.ts <user> <scenario> <out-dir> [widths]
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Page } from '@playwright/test';
import { readMfa, totpFor } from '../lib/auth';
import { BASE_URL, DEV_PASSWORD } from '../lib/env';
import { getState } from '../lib/state';

const [user = 'admin', scenario = 'shell', outDir = '.local/ui-audit-b/explore', widthsArg = '1366,768'] = process.argv.slice(2);
const H: Record<number, number> = { 1920: 1080, 1366: 768, 1024: 768, 768: 1024, 390: 844 };

async function login(page: Page) {
  await page.goto(`${BASE_URL}/login`);
  await page.getByLabel('Username').fill(user);
  await page.getByLabel('Password').fill(DEV_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const mfa = readMfa()[user];
  if (mfa) {
    await page.getByLabel('Verification code').fill(totpFor(mfa.secret));
    await page.getByRole('button', { name: 'Verify' }).click();
  }
  await page.getByRole('button', { name: 'Sign out' }).waitFor();
}

type Step = [name: string, run: (p: Page) => Promise<unknown>];
const go = (path: string) => async (p: Page) => { await p.goto(`${BASE_URL}${path}`); await p.waitForLoadState('networkidle').catch(() => undefined); };
const click = (name: string | RegExp, role: 'button' | 'link' | 'tab' = 'button') => (p: Page) => p.getByRole(role, { name }).first().click();
const esc = (p: Page) => p.keyboard.press('Escape');

const SCENARIOS: Record<string, Step[]> = {
  shell: [
    ['bell', async (p) => { await go('/')(p); await p.getByRole('button', { name: /^Notifications:/ }).click(); }],
    ['bell-scrolled', (p) => p.locator('[role=dialog][aria-label="Unread notifications"] ul').evaluate((el) => el.scrollTo(0, 9999))],
    ['menu', async (p) => { await esc(p); if (await p.getByRole('button', { name: 'Open menu' }).isVisible()) await click('Open menu')(p); }],
  ],
  cases: [
    ['new-case', async (p) => { await go('/cases')(p); await click('New case')(p); }],
    ['new-case-fir', (p) => p.getByLabel('Linked FIR').fill('E')],
    ['case-status', async (p) => { await esc(p); await go(`/cases/${getState('caseId')}`)(p); await click('Change status')(p); }],
    ['case-edit', async (p) => { await esc(p); await click('Edit')(p); }],
    ['case-link', async (p) => { await esc(p); await go(`/cases/${getState('caseId')}?tab=evidence`)(p); await click('Link evidence')(p); await p.getByLabel('Search evidence').fill('KSP'); await p.waitForTimeout(800); }],
    ['case-team-picker', async (p) => { await esc(p); await go(`/cases/${getState('caseId')}?tab=team`)(p); await p.getByRole('combobox', { name: 'Officer' }).fill('a'); await p.waitForTimeout(800); }],
    ['case-exports-tab', go(`/cases/${getState('caseId')}?tab=x-exports`)],
    ['fir-new', async (p) => { await go('/firs')(p); await click('Register FIR')(p); }],
    ['fir-import', async (p) => { await esc(p); await click('Import from CCTNS')(p); }],
  ],
  shares: [
    ['share-extend', async (p) => { await go('/shares?view=all')(p); await p.getByRole('table').getByRole('link').first().click(); await p.waitForLoadState('networkidle'); await click('Extend')(p); }],
    ['share-reissue', async (p) => { await esc(p); await click(/Re-issue link|Re-send link/)(p); }],
    ['share-revoke', async (p) => { await esc(p); await click('Revoke')(p); }],
    ['export-new-1', async (p) => { await esc(p); await go('/exports/new')(p); await p.getByLabel('Add evidence by number or title').fill('KSP'); await p.waitForTimeout(900); }],
    ['export-pending', go('/exports?view=pending')],
    ['export-verify', go('/exports/verify')],
  ],
  admin: [
    ['user-new-invalid', async (p) => { await go('/admin/users/new')(p); await p.getByRole('button', { name: /Create/ }).last().click(); }],
    ['user-detail-actions', go(`/admin/users?q=uxb.user6`)],
    ['org-add', async (p) => { await go('/admin/org')(p); await p.getByRole('button', { name: /^Add unit under / }).first().click(); }],
    ['device-new', async (p) => { await esc(p); await go('/admin/devices')(p); await p.getByRole('button', { name: /Register|New device|Add device/ }).first().click(); }],
    ['integration-new', async (p) => { await esc(p); await go('/admin/integrations')(p); await p.getByRole('button', { name: /Add|New/ }).first().click(); }],
    ['apiclient-new', async (p) => { await esc(p); await go('/admin/api-clients')(p); await click('New client')(p); }],
    ['alert-rules', async (p) => { await esc(p); await go('/alerts/rules')(p); }],
    ['alerts-p2', go('/alerts?page=2')],
    ['report-schedule', async (p) => { await go('/reports')(p); await click('New schedule')(p); }],
    ['health', async (p) => { await esc(p); await go('/system/health')(p); }],
  ],
  audit: [
    ['audit-event', async (p) => { await go('/compliance/audit')(p); await p.getByRole('table').getByRole('row').nth(1).click(); await p.waitForTimeout(700); }],
    ['audit-export', async (p) => { await esc(p); await click('Export')(p); }],
    ['audit-more', async (p) => { await esc(p); await click('Load more')(p); await p.waitForTimeout(800); await p.getByRole('button', { name: 'Load more' }).scrollIntoViewIfNeeded(); }],
    ['ledger', go('/compliance/ledger')],
  ],
};

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROME ?? '/opt/google/chrome/chrome' });
  let state: Awaited<ReturnType<import('@playwright/test').BrowserContext['storageState']>> | undefined;
  for (const width of widthsArg.split(',').map(Number)) {
    const ctx = await browser.newContext({ viewport: { width, height: H[width] ?? 900 }, storageState: state });
    const page = await ctx.newPage();
    page.on('console', (m) => m.type() === 'error' && console.log(`  console.error ${m.text().slice(0, 160)}`));
    page.on('response', (r) => r.url().includes('/api/') && r.status() >= 400 && console.log(`  ${r.status()} ${r.request().method()} ${r.url().replace(BASE_URL, '')}`));
    if (!state) { await login(page); state = await ctx.storageState(); }
    mkdirSync(resolve(outDir, String(width)), { recursive: true });
    for (const [name, run] of SCENARIOS[scenario] ?? []) {
      try {
        await run(page);
        await page.waitForTimeout(400);
        const info = await page.evaluate(() => ({ hs: document.documentElement.scrollWidth - document.documentElement.clientWidth, bodyOverflow: getComputedStyle(document.body).overflow, dialogs: Array.from(document.querySelectorAll('[role=dialog]')).map((d) => { const r = d.getBoundingClientRect(); return `${d.getAttribute('aria-label') ?? d.querySelector('h2')?.textContent}: top=${Math.round(r.top)} bottom=${Math.round(r.bottom)} vh=${innerHeight}`; }) }));
        await page.screenshot({ path: resolve(outDir, String(width), `x-${name}.png`) });
        console.log(`${width} ${name} ${JSON.stringify(info)}`);
      } catch (e) {
        console.log(`${width} ${name} FAILED ${(e as Error).message.split('\n')[0]}`);
      }
    }
    await ctx.close();
  }
  await browser.close();
}
void main();
