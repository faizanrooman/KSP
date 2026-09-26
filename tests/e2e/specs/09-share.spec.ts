/**
 * Scenario 9 — secure sharing: internal share to another officer; external share → /s/:token in a fresh,
 * unauthenticated context → wrong code → correct code → watermarked playback, no download; access log.
 */
import { expect, test } from '../lib/fixtures';
import { getState, runId, setState } from '../lib/state';

test.describe.configure({ mode: 'serial' });

test('internal share to another officer', async ({ as }) => {
  test.skip(!getState('evidenceB'), 'needs 02-upload');
  const page = await as('io.meera');
  await page.goto(`/evidence/${getState('evidenceB')}`);
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  const dlg = page.getByRole('dialog', { name: /^Share / });
  await dlg.getByLabel('Recipient type').selectOption('INTERNAL_USER');
  const user = dlg.getByRole('combobox', { name: 'User' });
  await user.fill('mysuru');
  await expect(page.getByRole('listbox', { name: 'Matching users' }).getByRole('option').first()).toContainText('Deepa Nayak');
  await expect(async () => {
    await user.press('ArrowDown');
    const id = await user.getAttribute('aria-activedescendant');
    expect(id).toBeTruthy();
    await expect(page.locator(`[id="${id}"]`)).toContainText('Deepa Nayak', { timeout: 500 });
  }).toPass({ timeout: 10_000 });
  await user.press('Enter');
  await dlg.getByRole('textbox', { name: 'Purpose' }).fill(`Cross-station review E2E ${runId()}`);
  await dlg.getByRole('button', { name: 'Create share' }).click();
  await expect(page.getByRole('status').filter({ hasText: /Shared with Deepa Nayak/ })).toBeVisible();

  const deepa = await as('io.mysuru');
  await deepa.goto('/shares?view=received');
  const row = deepa.getByRole('table').getByRole('row').filter({ hasText: `Cross-station review E2E ${runId()}` });
  await expect(row).toBeVisible();
  await row.getByRole('link').click();
  await deepa.getByRole('region', { name: /^Items/ }).getByRole('link').first().click();
  await expect(deepa.getByRole('heading', { level: 1 })).toContainText('KSP-');
});

test('external share: code gate, lockout counter, watermarked playback without download', async ({ as, anon, guard }) => {
  test.setTimeout(300_000);
  test.skip(!getState('evidenceB'), 'needs 02-upload');
  guard.expectFailure(/\/api\/v1\/share-portal\/open$/, 401);
  const page = await as('io.meera');
  await page.goto(`/evidence/${getState('evidenceB')}`);
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  const dlg = page.getByRole('dialog', { name: /^Share / });
  await dlg.getByLabel('Recipient type').selectOption('EXTERNAL');
  await dlg.getByLabel('Name').fill('APP Bengaluru');
  await dlg.getByLabel('E-mail').fill('app.e2e@example.invalid');
  await dlg.getByRole('textbox', { name: 'Purpose' }).fill(`Prosecution review E2E ${runId()}`);
  await expect(dlg.getByRole('checkbox', { name: /^Allow download/ })).not.toBeChecked();
  await dlg.getByRole('button', { name: 'Create share' }).click();
  const created = page.getByRole('dialog', { name: 'Share created' });
  await expect(created.getByText('Shown only once')).toBeVisible();
  const link = await created.getByLabel('Link').inputValue();
  const code = await created.getByLabel('Access code').inputValue();
  expect(link).toMatch(/\/s\/[A-Za-z0-9_-]{20,}$/);
  expect(code).toMatch(/^\d{4,}$/);
  setState('externalShareUrl', new URL(link).pathname);
  await created.getByRole('button', { name: 'Done' }).click();

  const ext = await anon();
  await ext.goto(new URL(link).pathname);
  await expect(ext.getByRole('heading', { name: 'Enter your access code' })).toBeVisible();
  await expect(ext.getByRole('navigation', { name: 'Main' })).toHaveCount(0); // no app shell
  const wrong = code === '000000' ? '111111' : '000000';
  await ext.getByLabel('Access code').fill(wrong);
  await ext.getByRole('button', { name: 'Open' }).click();
  await expect(ext.getByRole('alert')).toContainText(/Incorrect access code\. 4 attempts left/);
  await ext.getByLabel('Access code').fill(code);
  await ext.getByRole('button', { name: 'Open' }).click();

  const item = ext.getByRole('region', { name: /^Evidence / });
  const video = item.locator('video');
  await expect(video).toBeVisible({ timeout: 240_000 }); // watermarked copy rendered per share
  await expect(video).toHaveAttribute('controlslist', /nodownload/);
  await expect(item.getByRole('button', { name: /^Download/ })).toHaveCount(0);
  await expect.poll(async () => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
  const src = await video.getAttribute('src');
  expect(src).toMatch(/^\/api\/v1\//);

  // The sender sees the access log (failed code + open).
  await page.goto('/shares');
  await page.getByRole('table').getByRole('row').filter({ hasText: `Prosecution review E2E ${runId()}` }).getByRole('link').click();
  const log = page.getByRole('table', { name: 'Share access log' });
  await expect(log).toContainText(/Code Failed/i);
  await expect(log).toContainText(/Open/i);
});
