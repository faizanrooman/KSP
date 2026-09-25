/**
 * Scenario 1 — authentication UX: bad password, lockout, forced password change, TOTP login (bad + good code),
 * recovery-code login, logout, session expiry → login → back to the page the user was on.
 */
import { submitPassword, takeRecoveryCode, totp } from '../lib/auth';
import { DEV_PASSWORD } from '../lib/env';
import { expect, test } from '../lib/fixtures';
import { runId } from '../lib/state';

test('bad password shows a generic message and keeps the user on the login page', async ({ page, guard }) => {
  guard.expectFailure(/\/auth\/login$/, 401);
  await submitPassword(page, 'io.meera', 'Wrong-Passw0rd!');
  await expect(page.getByRole('alert')).toHaveText('Invalid username or password');
  await expect(page).toHaveURL(/\/login$/);
  // The password field is cleared; the username is kept.
  await expect(page.getByLabel('Password')).toHaveValue('');
  await expect(page.getByLabel('Username')).toHaveValue('io.meera');
  // Unknown users get the same message (no user enumeration).
  await submitPassword(page, 'no.such.user', 'Wrong-Passw0rd!');
  await expect(page.getByRole('alert')).toHaveText('Invalid username or password');
});

test('account lockout after repeated failures', async ({ page, guard }) => {
  guard.expectFailure(/\/auth\/login$/, [401, 423]);
  for (let i = 0; i < 5; i++) {
    await submitPassword(page, 'e2e.lockout', `Wrong-Passw0rd-${i}!`);
    await expect(page.getByRole('alert')).toHaveText('Invalid username or password');
  }
  // Even the correct password is refused while locked, with an explanatory message.
  await submitPassword(page, 'e2e.lockout', DEV_PASSWORD);
  await expect(page.getByRole('alert')).toContainText('Account is temporarily locked');
  await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
});

test('forced password change on first login', async ({ page, guard }) => {
  guard.expectFailure(/\/auth\/password\/change$/, 400);
  await submitPassword(page, 'e2e.pwchange');
  await expect(page.getByRole('heading', { name: 'Change your password' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);

  // Mismatch is caught client-side; a weak password is refused by the policy.
  await page.getByLabel('Current password').fill(DEV_PASSWORD);
  await page.getByRole('textbox', { name: 'New password', exact: true }).fill('Another-Passw0rd!');
  await page.getByLabel('Confirm new password').fill('Different-Passw0rd!');
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByRole('alert')).toHaveText('New passwords do not match');
  await page.getByRole('textbox', { name: 'New password', exact: true }).fill('short');
  await page.getByLabel('Confirm new password').fill('short');
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByRole('alert')).toContainText(/at least 12 characters/i);

  const next = `E2e-${runId()}-Passw0rd!`;
  await page.getByLabel('Current password').fill(DEV_PASSWORD);
  await page.getByRole('textbox', { name: 'New password', exact: true }).fill(next);
  await page.getByLabel('Confirm new password').fill(next);
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();

  // The new password works for a fresh login; the old one no longer does.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
  guard.expectFailure(/\/auth\/login$/, 401);
  await submitPassword(page, 'e2e.pwchange', DEV_PASSWORD);
  await expect(page.getByRole('alert')).toHaveText('Invalid username or password');
  await submitPassword(page, 'e2e.pwchange', next);
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
});

test('TOTP login: wrong code refused, right code accepted', async ({ page, guard }) => {
  guard.expectFailure(/\/auth\/mfa\/verify$/, 401);
  await submitPassword(page, 'sup.kavya');
  await expect(page.getByRole('heading', { name: 'Two-step verification' })).toBeVisible();
  const code = totp('sup.kavya');
  await page.getByLabel('Verification code').fill(code === '123456' ? '654321' : '123456');
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('alert')).toHaveText('Invalid verification code');
  await page.getByLabel('Verification code').fill(totp('sup.kavya'));
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await expect(page.getByRole('banner')).toContainText('Kavya Hegde');
});

test('recovery code login (single use)', async ({ page, guard }) => {
  guard.expectFailure(/\/auth\/mfa\/verify$/, 401);
  const code = takeRecoveryCode('aud.suresh');
  await submitPassword(page, 'aud.suresh');
  await page.getByRole('button', { name: 'Use a recovery code' }).click();
  await page.getByLabel('Recovery code').fill(code);
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  // Same code a second time is refused.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await submitPassword(page, 'aud.suresh');
  await page.getByRole('button', { name: 'Use a recovery code' }).click();
  await page.getByLabel('Recovery code').fill(code);
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('alert')).toHaveText('Invalid verification code');
});

test('logout ends the session; protected URLs redirect to login', async ({ as }) => {
  const page = await as('io.meera');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/evidence');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

test('session expiry mid-use redirects to login and returns to the page afterwards', async ({ as, guard }) => {
  guard.expectFailure(/\/api\/v1\//, 401); // requests made after the session vanished
  const page = await as('io.meera');
  await page.goto('/evidence');
  await expect(page.getByRole('heading', { name: 'Evidence', level: 1 })).toBeVisible();
  // Simulate expiry: the browser loses its session and refresh cookies (as when both have timed out).
  await page.context().clearCookies();
  await page.getByRole('link', { name: 'Search', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('Username').fill('io.meera');
  await page.getByLabel('Password').fill(DEV_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/search/);
});
