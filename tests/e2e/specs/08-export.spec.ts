/**
 * Scenario 8 — court export: IO requests a watermarked export; the custodian role cannot approve with the default
 * role matrix (export:approve is a SUPERVISOR permission), the supervisor approves (two-person rule); the package
 * is built by the worker, downloaded, and verified on the Verify page.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '../lib/fixtures';
import { getState, runId, setState } from '../lib/state';

test.describe.configure({ mode: 'serial' });

test('IO requests a watermarked export; cannot approve own request', async ({ as }) => {
  test.skip(!getState('evidenceA'), 'needs 02-upload');
  const page = await as('io.meera');
  await page.goto(`/evidence/${getState('evidenceA')}`);
  await page.getByRole('button', { name: 'Export for court' }).click();
  await expect(page.getByRole('heading', { name: 'New court export' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Items (1)' })).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  const contents = page.getByRole('region', { name: 'Package contents' });
  await expect(contents.getByRole('checkbox', { name: /^Watermarked viewing copies/ })).toBeChecked();
  await expect(contents.getByRole('checkbox', { name: /^Original files/ })).not.toBeChecked();
  await page.getByLabel('Extra watermark text (optional)').fill(`E2E ${runId()}`);
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('textbox', { name: 'Purpose' }).fill('Production before the Magistrate court (E2E)');
  await page.getByLabel('Court', { exact: true }).fill('ACMM Court, Bengaluru');
  await page.getByLabel('Recipient').fill('Public Prosecutor');
  while (!(await page.getByRole('button', { name: 'Submit for approval' }).isVisible())) await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(page.getByRole('status').filter({ hasText: /submitted for approval/ })).toBeVisible();
  await expect(page).toHaveURL(/\/exports\/[0-9a-f-]{36}$/);
  setState('exportId', new URL(page.url()).pathname.split('/').pop());
  await expect(page.getByRole('main')).toContainText(/Pending approval/i);
  await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0); // separation of duties
});

test('custodian has no export approval permission (default role matrix)', async ({ as }) => {
  const page = await as('ec.latha');
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Court exports' })).toHaveCount(0);
  await page.goto(`/exports/${getState('exportId')}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Access denied' })).toBeVisible();
});

test('supervisor approves; package builds; requester downloads and verifies it', async ({ as }) => {
  test.setTimeout(300_000);
  test.skip(!getState('exportId'), 'needs the export request');
  const kavya = await as('sup.kavya');
  await kavya.goto('/exports?view=pending');
  await kavya.getByRole('table', { name: 'Exports' }).getByRole('link').filter({ hasText: /EXP|KSP/ }).first().isVisible();
  await kavya.goto(`/exports/${getState('exportId')}`);
  await kavya.getByRole('button', { name: 'Approve' }).click();
  const dlg = kavya.getByRole('dialog', { name: 'Approve export' });
  await dlg.getByRole('button', { name: 'Approve' }).click();
  await expect(kavya.getByRole('status').filter({ hasText: 'Approved — the package is being built' })).toBeVisible();

  const meera = await as('io.meera');
  await meera.goto(`/exports/${getState('exportId')}`);
  await expect(meera.getByRole('button', { name: 'Download package' })).toBeVisible({ timeout: 240_000 });
  await expect(meera.getByRole('table').first()).toContainText('Match');
  const [dl] = await Promise.all([meera.waitForEvent('download'), meera.getByRole('button', { name: 'Download package' }).click()]);
  const zip = (await dl.path())!;
  expect(readFileSync(zip).subarray(0, 2).toString()).toBe('PK');
  expect(dl.suggestedFilename()).toMatch(/\.zip$/);
  await expect(meera.getByRole('status').filter({ hasText: /Download started .* Package SHA-256/ })).toBeVisible();

  await meera.goto('/exports/verify');
  await meera.getByLabel(/Export package/).setInputFiles({ name: dl.suggestedFilename(), mimeType: 'application/zip', buffer: readFileSync(zip) });
  await meera.getByRole('button', { name: 'Verify' }).click();
  await expect(meera.getByText('Package verified')).toBeVisible({ timeout: 60_000 });
  await expect(meera.getByRole('table', { name: 'Package files' })).toContainText(/manifest/);
});
