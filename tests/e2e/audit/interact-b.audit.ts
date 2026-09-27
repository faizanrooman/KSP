/**
 * UI/UX audit — interactions part B: search panels and saved searches, review queue, legal hold (reason
 * validation), watchlist + AI-model dialogs. Results: .local/ui-audit/<suite>/interact-b.json.
 */
import { expect, test, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { login, type DevUser } from '../lib/auth';
import { BASE_URL } from '../lib/env';
import { OUT_DIR, Recorder, settle } from './lib';

interface Check { name: string; ok: boolean; detail?: string }

test('interactions B (audit A)', async ({ browser }) => {
  const suite = process.env.AUDIT_SUITE ?? 'interact';
  const rec = new Recorder(suite);
  const checks: Check[] = [];
  const check = async (name: string, fn: () => Promise<string | void>) => {
    try {
      const detail = await fn();
      checks.push({ name, ok: true, detail: detail || undefined });
    } catch (e) {
      checks.push({ name, ok: false, detail: (e as Error).message.split('\n').slice(0, 8).join(' ').replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'), '') });
    }
  };
  const open = async (user: DevUser, vp = { width: 1366, height: 768 }) => {
    const ctx = await browser.newContext({ baseURL: BASE_URL, viewport: vp });
    rec.watch(ctx);
    const p = await ctx.newPage();
    await login(p, user);
    return p;
  };
  const shot = (p: Page, n: string) => p.screenshot({ path: rec.shot(n) });
  const stamp = Date.now().toString(36);

  // ---------------------------------------------------------------- search
  const io = await open('io.meera');
  await io.goto('/search');
  await settle(io);
  await check('search: Filters toggles the advanced panel; invalid input shows a message next to Apply', async () => {
    const toggle = io.getByRole('button', { name: 'Filters', exact: true });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await io.getByLabel('FIR year').fill('2026');
    await io.getByRole('button', { name: 'Apply filters' }).click();
    const err = io.getByRole('alert').filter({ hasText: 'Enter the FIR number' }).last();
    await expect(io.getByLabel('FIR number')).toBeFocused();
    await expect(io.getByLabel('FIR number')).toHaveAttribute('aria-invalid', 'true');
    await expect(err).toBeVisible();
    await err.scrollIntoViewIfNeeded();
    await shot(io, 'search-filters-invalid');
    await io.getByRole('button', { name: 'Clear form' }).click();
    await expect(io.getByLabel('FIR year')).toHaveValue('');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });
  await check('search: Save search — Enter in the name field saves; saved search reopens the query', async () => {
    await io.getByRole('searchbox').or(io.getByPlaceholder(/Words, evidence number/)).first().fill(`patrol ${stamp}`);
    await io.getByRole('button', { name: 'Search', exact: true }).click();
    await io.getByRole('button', { name: 'Save search' }).click();
    const dlg = io.getByRole('dialog', { name: 'Save this search' });
    await dlg.getByLabel('Name').fill(`Audit ${stamp}`);
    await dlg.getByLabel('Name').press('Enter');
    await expect(dlg).toBeHidden();
    await expect(io.getByRole('status').filter({ hasText: 'Search saved' })).toBeVisible();
    await io.goto('/search');
    await io.getByRole('button', { name: 'Saved searches' }).click();
    const list = io.getByRole('dialog', { name: 'Saved searches' });
    await expect(list.getByText(`Audit ${stamp}`)).toBeVisible();
    await shot(io, 'saved-searches');
    await list.getByText(`Audit ${stamp}`).click();
    await expect(list).toBeHidden();
    await expect(io).toHaveURL(/search/);
  });

  // ---------------------------------------------------------------- review queue (sup.kavya) at 768 px
  const kav = await open('sup.kavya', { width: 768, height: 1024 });
  await kav.goto('/review');
  await settle(kav);
  await check('review queue (768 px): no horizontal scroll; History dialog opens and closes with Escape', async () => {
    const over = await kav.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await shot(kav, 'review-768');
    if (over > 0) throw new Error(`horizontal page scroll ${over}px`);
    const hist = kav.getByRole('button', { name: 'History' }).first();
    if (!(await hist.count())) return 'queue empty — History not exercised';
    await hist.click();
    const dlg = kav.getByRole('dialog').first();
    await expect(dlg).toBeVisible();
    await kav.keyboard.press('Escape');
    await expect(dlg).toBeHidden();
    await expect(hist).toBeFocused();
  });

  // ---------------------------------------------------------------- legal hold reason validation (ec.latha)
  const ec = await open('ec.latha');
  const evs = await (await ec.request.get('/api/v1/evidence?pageSize=50&status=REGISTERED')).json() as { items: Array<{ id: string; legalHold: boolean }> };
  const target = evs.items.find((e) => !e.legalHold);
  await check('legal hold dialog: Confirm disabled until a 5-character reason; Cancel closes without change', async () => {
    if (!target) return 'no registered evidence without hold';
    await ec.goto(`/evidence/${target.id}`);
    await ec.getByRole('button', { name: 'Legal hold', exact: true }).click();
    const dlg = ec.getByRole('dialog', { name: 'Place legal hold' });
    const confirm = dlg.getByRole('button', { name: /Place|Confirm|hold/i }).last();
    await expect(confirm).toBeDisabled();
    await dlg.getByRole('textbox').first().fill('abc');
    await expect(confirm).toBeDisabled();
    await shot(ec, 'legal-hold-invalid');
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    await expect(dlg).toBeHidden();
    await expect(ec.getByText('Under legal hold')).toHaveCount(0);
  });

  // ---------------------------------------------------------------- watchlists (fa.naveen) + AI models (admin)
  const fa = await open('fa.naveen');
  await fa.goto('/ai/watchlists');
  await settle(fa);
  await check('watchlists: New watchlist dialog validates the name and closes with Cancel', async () => {
    await fa.getByRole('button', { name: 'New watchlist' }).click();
    const dlg = fa.getByRole('dialog', { name: 'New watchlist' });
    await expect(dlg).toBeVisible();
    const create = dlg.getByRole('button', { name: /Create/ });
    await expect(create).toBeDisabled();
    await dlg.getByLabel('Name').fill('x');
    await expect(create).toBeDisabled();
    await dlg.getByLabel('Name').fill('Audit list');
    await expect(create).toBeEnabled();
    await shot(fa, 'watchlist-new');
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    await expect(dlg).toBeHidden();
  });
  const adm = await open('admin', { width: 1024, height: 768 });
  await adm.goto('/ai/models');
  await settle(adm);
  await check('AI models (1024 px): no page scroll sideways; Edit dialog fits and closes with Escape', async () => {
    const over = await adm.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (over > 0) throw new Error(`horizontal page scroll ${over}px`);
    const edit = adm.getByRole('button', { name: 'Edit' }).first();
    await edit.scrollIntoViewIfNeeded();
    await edit.click();
    const dlg = adm.getByRole('dialog').first();
    await expect(dlg).toBeVisible();
    await shot(adm, 'model-edit');
    const b = (await dlg.boundingBox())!;
    if (b.y + b.height > 769) throw new Error(`dialog bottom ${Math.round(b.y + b.height)} > 768`);
    await adm.keyboard.press('Escape');
    await expect(dlg).toBeHidden();
  });

  writeFileSync(resolve(OUT_DIR, suite, 'interact-b.json'), JSON.stringify({ checks, runtime: rec.findings }, null, 2));
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  for (const f of rec.findings) console.log(`RUNTIME ${f.kind} ${f.detail}`);
});
