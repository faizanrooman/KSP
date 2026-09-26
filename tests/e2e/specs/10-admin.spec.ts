/**
 * Scenario 10 — administration & operations: create user (one-time password shown once) → first sign-in forces a
 * password change; grant a role; disable; roles matrix; org unit; device; settings change; alerts (acknowledge);
 * reports (run + download); system health; dashboards render with data.
 */
import { readFileSync } from 'node:fs';
import { submitPassword } from '../lib/auth';
import { expect, test } from '../lib/fixtures';
import { runId } from '../lib/state';

test('create user → one-time password → forced change → grant role → disable', async ({ as, anon, guard }) => {
  guard.expectFailure(/\/auth\/login$/, 403);
  const admin = await as('admin');
  await admin.getByRole('link', { name: 'Users' }).click();
  await admin.getByRole('button', { name: /New user/ }).or(admin.getByRole('link', { name: /New user/ })).first().click();
  const username = `e2e.user${runId().slice(-6)}${Math.floor(Math.random() * 90 + 10)}`;
  await admin.getByLabel('Username').fill(username);
  await admin.getByLabel('Full name').fill(`E2E User ${runId()}`);
  await admin.getByLabel('Home unit').selectOption({ label: 'Cubbon Park Police Station' }).catch(async () => {
    const opts = await admin.getByLabel('Home unit').locator('option').allTextContents();
    await admin.getByLabel('Home unit').selectOption({ label: opts.find((o) => /Cubbon Park/.test(o))! });
  });
  await admin.getByRole('button', { name: 'Add role' }).click();
  await admin.getByLabel('Role', { exact: true }).selectOption({ label: 'Field Officer' });
  await admin.getByRole('button', { name: 'Create user' }).click();
  const otp = admin.getByRole('dialog', { name: 'Temporary password' });
  await expect(otp.getByText('Shown only once')).toBeVisible();
  const password = (await otp.getByLabel('Temporary password').textContent())!.trim();
  expect(password.length).toBeGreaterThanOrEqual(12);
  await otp.getByRole('button', { name: 'I have recorded it' }).click();
  await expect(admin).toHaveURL(/\/admin\/users\/[0-9a-f-]{36}/);
  await expect(admin.getByText(password)).toHaveCount(0); // never shown again

  // First sign-in forces a password change.
  const user = await anon();
  await submitPassword(user, username, password);
  await expect(user.getByRole('heading', { name: 'Change your password' })).toBeVisible();
  const next = `E2e-${runId()}-New-Pass!`;
  await user.getByLabel('Current password').fill(password);
  await user.getByRole('textbox', { name: 'New password', exact: true }).fill(next);
  await user.getByLabel('Confirm new password').fill(next);
  await user.getByRole('button', { name: 'Change password' }).click();
  await expect(user.getByRole('navigation', { name: 'Main' })).toBeVisible();
  // Field officer nav: no admin items.
  await expect(user.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Users' })).toHaveCount(0);

  // Grant an extra role, then disable the account.
  await admin.reload();
  await admin.getByRole('button', { name: 'Grant role' }).click();
  const grant = admin.getByRole('dialog', { name: 'Grant role' });
  await grant.getByLabel('Role').selectOption({ label: 'Station Upload Operator' });
  await grant.getByRole('button', { name: /Grant/ }).click();
  await expect(admin.getByRole('status').filter({ hasText: 'Role granted' })).toBeVisible();
  await expect(admin.getByRole('table', { name: 'Role assignments' })).toContainText('Station Upload Operator');
  await admin.getByRole('button', { name: 'Disable' }).click();
  const dis = admin.getByRole('dialog', { name: 'Disable account' });
  await expect(dis.getByRole('textbox', { name: /Reason/ })).toBeFocused();
  await admin.keyboard.type('Left the service (E2E)');
  await dis.getByRole('button', { name: 'Disable' }).click();
  await expect(admin.getByRole('status').filter({ hasText: 'Disable account: done' })).toBeVisible();
  await expect(admin.getByRole('main')).toContainText(/Disabled/);

  const again = await anon();
  await submitPassword(again, username, next);
  await expect(again.getByRole('alert')).toContainText('This account is not active');
});

test('roles matrix, org unit, device, settings', async ({ as }) => {
  const admin = await as('admin');
  await admin.goto('/admin/roles');
  const roles = admin.getByRole('table', { name: 'Roles' });
  await expect(roles).toContainText('Investigating Officer');
  await roles.getByRole('row').filter({ hasText: 'Evidence Custodian' }).click();
  await expect(admin.getByRole('heading', { level: 1 })).toContainText('Evidence Custodian');
  await expect(admin.getByRole('main')).toContainText('retention:manage');

  // Org unit under a station's parent.
  await admin.goto('/admin/org');
  const add = admin.getByRole('button', { name: /^Add unit under / }).nth(1);
  await add.click();
  const dlg = admin.getByRole('dialog', { name: /^New unit under/ });
  await dlg.getByLabel('Code').fill(`e2e_${runId().slice(-8)}_${Math.floor(Math.random() * 900 + 100)}`);
  const types = await dlg.getByLabel('Type').locator('option').evaluateAll((o) => (o as HTMLOptionElement[]).map((x) => x.value).filter(Boolean));
  await dlg.getByLabel('Type').selectOption(types[types.length - 1]!);
  await dlg.getByLabel('Name').fill(`E2E Unit ${runId()}`);
  await dlg.getByRole('button', { name: /Create|Save/ }).click();
  await expect(admin.getByRole('status').filter({ hasText: 'Unit created' })).toBeVisible();
  await expect(admin.getByRole('main')).toContainText(`E2E Unit ${runId()}`);

  // Device registration.
  await admin.goto('/admin/devices');
  await admin.getByRole('button', { name: /Register device/ }).click();
  const dv = admin.getByRole('dialog', { name: 'Register device' });
  const serial = `E2E-${runId()}-${Math.floor(Math.random() * 900 + 100)}`;
  await dv.getByLabel('Serial number').fill(serial);
  const dtypes = await dv.getByLabel('Type').locator('option').evaluateAll((o) => (o as HTMLOptionElement[]).map((x) => x.value).filter(Boolean));
  await dv.getByLabel('Type').selectOption(dtypes[0]!);
  const units = await dv.getByLabel('Owning unit').locator('option').evaluateAll((o) => (o as HTMLOptionElement[]).map((x) => x.value).filter(Boolean));
  await dv.getByLabel('Owning unit').selectOption(units[0]!);
  await dv.getByLabel('Make').fill('Axon');
  await dv.getByRole('button', { name: /Register|Save/ }).click();
  await expect(admin.getByRole('status').filter({ hasText: 'Device registered' })).toBeVisible();
  await expect(admin.getByRole('heading', { level: 1 })).toContainText(serial);
  await admin.goto(`/admin/devices?q=${encodeURIComponent(serial)}`);
  await expect(admin.getByRole('table')).toContainText(serial);

  // Settings change (then restore defaults).
  await admin.goto('/admin/settings');
  const share = admin.getByRole('region', { name: /Sharing & export/ }).or(admin.locator('section').filter({ hasText: 'Sharing & export' })).first();
  const field = share.getByLabel('Excessive downloads alert (per hour)');
  await field.fill('25');
  await share.getByRole('button', { name: 'Save' }).click();
  await expect(admin.getByRole('status').filter({ hasText: 'Sharing & export saved' })).toBeVisible();
  await admin.reload();
  await expect(share.getByLabel('Excessive downloads alert (per hour)')).toHaveValue('25');
  await share.getByRole('button', { name: 'Restore defaults' }).click();
  await admin.getByRole('dialog').getByRole('button', { name: /Restore/ }).click();
  await expect(admin.getByRole('status').filter({ hasText: 'restored to defaults' })).toBeVisible();
});

test('alerts: list, detail, acknowledge', async ({ as }) => {
  const page = await as('sup.kavya');
  await page.getByRole('link', { name: 'Alerts', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Alerts', level: 1 })).toBeVisible();
  await page.getByLabel('Status').selectOption('OPEN');
  const table = page.getByRole('table');
  const hasOpen = await table.getByRole('row').nth(1).isVisible().catch(() => false);
  test.skip(!hasOpen, 'no OPEN alert in the supervisor’s jurisdiction at this moment (rules evaluate every minute)');
  await table.getByRole('row').nth(1).click();
  await page.getByRole('button', { name: 'Acknowledge' }).click();
  await page.getByRole('dialog', { name: 'Acknowledge alert' }).getByRole('button', { name: /Acknowledge/ }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Alert acknowledged' })).toBeVisible();
  await expect(page.getByRole('main')).toContainText(/Acknowledged/);
});

test('reports: run and download; system health; dashboards render with data', async ({ as }) => {
  test.setTimeout(180_000);
  const admin = await as('admin');
  await admin.goto('/reports');
  await expect.poll(() => admin.getByLabel('Report type').locator('option:not([disabled])').count()).toBeGreaterThan(1);
  const types = await admin.getByLabel('Report type').locator('option').evaluateAll((o) => (o as HTMLOptionElement[]).filter((x) => !x.disabled).map((x) => ({ v: x.value, t: x.textContent ?? '' })).filter((x) => x.v));
  const pick = types.find((t) => /user|access/i.test(t.t)) ?? types[0]!;
  await admin.getByLabel('Report type').selectOption(pick.v);
  await admin.getByLabel('Format').selectOption('CSV');
  await admin.getByRole('button', { name: 'Run report' }).click();
  await expect(admin.getByRole('status').filter({ hasText: 'Report queued' })).toBeVisible();
  const runs = admin.getByRole('region', { name: 'My report runs' });
  const dlBtn = runs.getByRole('button', { name: /Download/ }).first();
  await expect(dlBtn).toBeVisible({ timeout: 120_000 });
  const [dl] = await Promise.all([admin.waitForEvent('download'), dlBtn.click()]);
  expect(readFileSync((await dl.path())!).toString('utf8').split('\n').length).toBeGreaterThan(1);

  await admin.goto('/system/health');
  await expect(admin.getByRole('heading', { level: 1 })).toContainText(/health/i);
  await expect(admin.getByRole('main')).toContainText('Object storage');
  await expect(admin.getByRole('main')).toContainText(/Database/);
  await expect(admin.getByRole('main')).not.toContainText(/k[a-z0-9]+-(evidence|staging|derived)/); // roles, not bucket names

  await admin.goto('/');
  await expect(admin.getByRole('heading', { level: 1 })).toBeVisible();
  const kavya = await as('sup.kavya');
  await kavya.goto('/');
  const main = kavya.getByRole('main');
  await expect(main.getByRole('heading', { level: 1 })).toBeVisible();
  // Charts carry text alternatives (figure/summary) — data present after the uploads of this run.
  await expect(main.getByRole('img').or(main.getByRole('figure')).first()).toBeVisible();
  await expect(main).toContainText(/\d/);
});
