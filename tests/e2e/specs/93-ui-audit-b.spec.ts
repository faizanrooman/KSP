/**
 * UI audit B regressions (docs/UI-AUDIT-B.md): behaviour found broken by hand on the auth, shell, cases, sharing,
 * export, compliance and administration screens. Each test names the finding it guards.
 */
import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { ARTIFACT_DIR } from '../lib/env';
import { expect, test } from '../lib/fixtures';
import { getState, runId } from '../lib/state';

const SHOTS = resolve(ARTIFACT_DIR, 'ui-audit-b');

async function noHorizontalScroll(page: Page) {
  const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: document.documentElement.clientWidth }));
  expect(o.sw, `page scrollWidth ${o.sw} > ${o.w}`).toBeLessThanOrEqual(o.w);
}

test('UI-B-01/04: typing into a later dialog field keeps focus; the page behind does not scroll', async ({ as }) => {
  test.skip(!getState('caseId'), 'needs 06-cases');
  const page = await as('sup.kavya', { context: { viewport: { width: 1280, height: 700 } } });
  await page.goto(`/cases/${getState('caseId')}`);
  await page.getByRole('button', { name: 'Change status' }).click();
  const dlg = page.getByRole('dialog', { name: 'Change case status' });
  const reason = dlg.getByRole('textbox', { name: /Reason/ });
  await reason.click();
  await reason.pressSequentially('Checking focus stays here');
  await expect(reason).toBeFocused();
  await expect(reason).toHaveValue('Checking focus stays here');
  expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).toBe('hidden');
  await page.keyboard.press('Escape');
  await expect(dlg).toBeHidden();
  await expect(page.getByRole('button', { name: 'Change status' })).toBeFocused();
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
});

test('UI-B-02: tables with sr-only headers do not widen the page at 1024 px', async ({ as }) => {
  const page = await as('admin', { context: { viewport: { width: 1024, height: 768 } } });
  for (const path of ['/reports', '/admin/api-clients', '/admin/users']) {
    await page.goto(path);
    await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('main').getByRole('table').first()).toBeVisible();
    await noHorizontalScroll(page);
  }
});

test('UI-B-03: off-canvas menu is modal — Esc closes it and focus returns to the menu button', async ({ as }) => {
  const page = await as('io.meera', { context: { viewport: { width: 768, height: 1024 } } });
  const open = page.getByRole('button', { name: 'Open menu' });
  await open.click();
  const menu = page.getByRole('dialog', { name: 'Menu' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('link').first()).toBeFocused();
  expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).toBe('hidden');
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(open).toBeFocused();
  await open.click();
  await menu.getByRole('button', { name: 'Close menu' }).click();
  await expect(menu).toBeHidden();
});

test('UI-B-07: saving one settings group keeps unsaved edits in another group', async ({ as }) => {
  const page = await as('admin');
  await page.goto('/admin/settings');
  const pw = page.getByLabel('Maximum password age (days)');
  const lock = page.getByLabel('Lockout duration (minutes)');
  const pwBefore = await pw.inputValue();
  const lockBefore = await lock.inputValue();
  await pw.fill(String(Number(pwBefore) === 90 ? 91 : 90));
  const lockCard = page.locator('section').filter({ has: lock });
  await lock.fill(String(Number(lockBefore) === 15 ? 16 : 15));
  await lockCard.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Account lockout saved' })).toBeVisible();
  await expect(pw, 'unsaved password-policy edit survives').not.toHaveValue(pwBefore);
  // Restore both.
  await page.locator('section').filter({ has: pw }).getByRole('button', { name: 'Discard' }).click();
  await expect(pw).toHaveValue(pwBefore);
  await lock.fill(lockBefore);
  await lockCard.getByRole('button', { name: 'Save' }).click();
  await expect(lock).toHaveValue(lockBefore);
});

test(`search inputs on shares/exports do not query per keystroke`, async ({ as }) => {
  const page = await as('io.meera');
  for (const [path, label] of [['/shares', 'Search'], ['/exports', 'Search']] as const) {
    await page.goto(path);
    await expect(page.getByRole('main').getByRole('table').or(page.getByText(/No shares|No exports/)).first()).toBeVisible();
    const requests: string[] = [];
    const onReq = (r: { url: () => string }) => { if (/\/api\/v1\/(shares|exports)\?/.test(r.url())) requests.push(r.url()); };
    page.on('request', onReq);
    await page.getByLabel(label, { exact: true }).pressSequentially(`e2e${runId()}`, { delay: 30 });
    await expect.poll(() => requests.length, { timeout: 5_000 }).toBeGreaterThan(0);
    await page.waitForTimeout(600);
    page.off('request', onReq);
    expect(requests.length, requests.join('\n')).toBeLessThanOrEqual(2);
  }
});

async function createExternalShare(page: Page, purpose: string, opts: { print?: boolean } = {}) {
  await page.goto(`/evidence/${getState('evidenceB')}`);
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  const dlg = page.getByRole('dialog', { name: /^Share / });
  await dlg.getByLabel('Recipient type').selectOption('EXTERNAL');
  await dlg.getByLabel('Name').fill('Venkataramanaiah Subramanyaswamy Chandrashekaraiah');
  await dlg.getByLabel('E-mail').fill('very.long.recipient.address.for.layout@karnataka-prosecution.example.invalid');
  await dlg.getByLabel('Organisation').fill('Office of the Public Prosecutor, City Civil and Sessions Court');
  await dlg.getByRole('textbox', { name: 'Purpose' }).fill(purpose);
  if (opts.print) await dlg.getByRole('checkbox', { name: 'Allow printing watermarked stills' }).check();
  await dlg.getByRole('button', { name: 'Create share' }).click();
  const created = page.getByRole('dialog', { name: 'Share created' });
  const link = new URL(await created.getByLabel('Link').inputValue()).pathname;
  const code = await created.getByLabel('Access code').inputValue();
  await created.getByRole('button', { name: 'Done' }).click();
  await expect(created).toBeHidden();
  return { link, code };
}

test('share portal: code form, lockout message and viewer fit phone and tablet widths', async ({ as, anon, guard }) => {
  test.setTimeout(300_000);
  test.skip(!getState('evidenceB'), 'needs 02-upload');
  guard.expectFailure(/\/api\/v1\/share-portal\/open$/, [401, 403, 410, 423]);
  const page = await as('io.meera');
  const locked = await createExternalShare(page, `UI audit lockout ${runId()} ${Date.now()}`);
  const ok = await createExternalShare(page, `UI audit viewer ${runId()} ${Date.now()}`, { print: true });

  const phone = await anon({ viewport: { width: 390, height: 844 } });
  const authCalls: string[] = [];
  phone.on('request', (r) => { if (/\/api\/v1\/auth\//.test(r.url())) authCalls.push(r.url()); });
  await phone.goto(locked.link);
  await expect(phone.getByLabel('Access code')).toBeVisible();
  expect(authCalls, 'UI-B-15: no staff-session probe on the public portal').toEqual([]);
  const wrong = locked.code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) {
    const field = phone.getByLabel('Access code');
    if (!(await field.isVisible())) break;
    await field.fill(wrong);
    await phone.getByRole('button', { name: 'Open' }).click();
    await expect(phone.getByRole('alert')).toBeVisible();
  }
  await expect(phone.getByRole('alert')).toContainText(/locked|not available/i);
  await expect(phone.getByRole('alert'), 'UI-B-14: contact advice not doubled').not.toContainText(/sender Contact/);
  await noHorizontalScroll(phone);
  await phone.screenshot({ path: `${SHOTS}/390-locked.png`, fullPage: true });

  for (const width of [390, 768]) {
    const ext = await anon({ viewport: { width, height: width === 390 ? 844 : 1024 } });
    await ext.goto(ok.link);
    await ext.getByLabel('Access code').fill(ok.code);
    await ext.getByRole('button', { name: 'Open' }).click();
    const item = ext.getByRole('region', { name: /^Evidence / });
    await expect(item.locator('video')).toBeVisible({ timeout: 240_000 });
    await expect(item.getByRole('button', { name: 'Print current frame' })).toBeVisible();
    await noHorizontalScroll(ext);
    await ext.screenshot({ path: `${SHOTS}/${width}-portal-viewer.png`, fullPage: true });
  }
});
