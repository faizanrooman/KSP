/**
 * Forced MFA enrolment through the UI for every MFA-mandatory role (global-setup reset them), recording the
 * TOTP secret and recovery codes for the rest of the run.
 */
import { MFA_USERS, saveMfa, submitPassword, totpFor } from '../lib/auth';
import { expect, test } from '../lib/fixtures';

for (const user of MFA_USERS) {
  test(`forced MFA enrolment: ${user}`, async ({ page, guard }) => {
    guard.expectFailure(/\/auth\/mfa\/confirm$/, 400);
    await page.goto('/login');
    await submitPassword(page, user);
    await expect(page.getByRole('heading', { name: 'Set up two-step verification' })).toBeVisible();
    await expect(page.getByText('Your role requires multi-factor authentication.')).toBeVisible();
    // The app shell is not reachable before enrolment.
    await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Set up authenticator' }).click();
    await expect(page.getByRole('img', { name: /QR code/ })).toBeVisible();
    const secret = (await page.getByTestId('mfa-secret').textContent())!.replace(/\s+/g, '');
    expect(secret).toMatch(/^[A-Z2-7]{16,}$/);

    // A wrong code is refused with a message.
    await page.getByLabel('Verification code').fill('000000');
    await page.getByRole('button', { name: 'Verify and enable' }).click();
    await expect(page.getByRole('alert')).toContainText(/invalid/i);

    await page.getByLabel('Verification code').fill(totpFor(secret));
    await page.getByRole('button', { name: 'Verify and enable' }).click();
    await expect(page.getByText('Two-step verification enabled')).toBeVisible();
    const codes = (await page.getByRole('list', { name: 'Recovery codes' }).getByRole('listitem').allTextContents()).map((c) => c.trim());
    expect(codes.length).toBeGreaterThanOrEqual(8);
    saveMfa(user, { secret, recoveryCodes: codes });
    await page.getByRole('button', { name: 'I have saved my recovery codes' }).click();
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  });
}
