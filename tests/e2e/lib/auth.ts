import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { authenticator } from 'otplib';
import { DEV_PASSWORD, STATE_DIR } from './env';

authenticator.options = { window: 1, step: 30 };

export type DevUser = 'admin' | 'fo.ravi' | 'op.cubbon' | 'io.meera' | 'io.arjun' | 'sup.kavya' | 'fa.naveen' | 'ec.latha' | 'aud.suresh' | 'io.mysuru';
/** Roles whose policy makes MFA enrolment mandatory (docs/CONTRACTS.md §2). */
export const MFA_USERS: DevUser[] = ['admin', 'sup.kavya', 'aud.suresh', 'ec.latha'];

interface MfaEntry {
  secret: string;
  recoveryCodes: string[];
}
const MFA_FILE = resolve(STATE_DIR, 'mfa.json');

export function readMfa(): Record<string, MfaEntry> {
  return existsSync(MFA_FILE) ? (JSON.parse(readFileSync(MFA_FILE, 'utf8')) as Record<string, MfaEntry>) : {};
}
export function saveMfa(user: string, entry: MfaEntry): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(MFA_FILE, JSON.stringify({ ...readMfa(), [user]: entry }, null, 2));
}
export function totp(user: string): string {
  const e = readMfa()[user];
  if (!e) throw new Error(`no MFA secret recorded for ${user} — run the setup project (tests/e2e/specs/00-setup.spec.ts)`);
  return authenticator.generate(e.secret);
}
export function totpFor(secret: string): string {
  return authenticator.generate(secret);
}
/** Take (and consume) one unused recovery code. */
export function takeRecoveryCode(user: string): string {
  const all = readMfa();
  const e = all[user];
  const code = e?.recoveryCodes.shift();
  if (!e || !code) throw new Error(`no recovery code left for ${user}`);
  saveMfa(user, e);
  return code;
}

export async function submitPassword(page: Page, username: string, password = DEV_PASSWORD): Promise<void> {
  if (!/\/login/.test(page.url())) await page.goto('/login');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** Full UI login (password, then TOTP for MFA users). Ends on the authenticated app shell. */
export async function login(page: Page, username: DevUser | string, opts: { password?: string; to?: string } = {}): Promise<void> {
  await page.goto(opts.to ? opts.to : '/login');
  if (!/\/login/.test(page.url())) await page.waitForURL(/\/login/);
  await submitPassword(page, username, opts.password);
  if (MFA_USERS.includes(username as DevUser) || readMfa()[username]) {
    const code = page.getByLabel('Verification code');
    await expect(code).toBeVisible();
    await code.fill(totp(username));
    await page.getByRole('button', { name: 'Verify' }).click();
  }
  // The app shell (sidebar is collapsed behind a menu button below 1024 px, the header is always there).
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}
