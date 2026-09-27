/**
 * UI audit B probe: sign in, open one page at one viewport, run a JS expression and print the result
 * (optionally screenshot). Debug helper for layout findings.
 *   npx tsx tests/e2e/audit/b-probe.ts <user> <path> <width>x<height> '<js expression>' [screenshot.png]
 */
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { readMfa, totpFor } from '../lib/auth';
import { BASE_URL, DEV_PASSWORD } from '../lib/env';

const [user = 'admin', path = '/', size = '1024x768', exprArg = 'document.title', shot] = process.argv.slice(2);
const expr = exprArg.startsWith('@') ? readFileSync(exprArg.slice(1), 'utf8') : exprArg; // @file.js
const [w, h] = size.split('x').map(Number);

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROME ?? '/opt/google/chrome/chrome' });
  const page = await browser.newPage({ viewport: { width: w!, height: h! } });
  page.on('console', (m) => m.type() === 'error' && console.log('console.error:', m.text().slice(0, 200)));
  if (user !== 'anon') {
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
  await page.goto(`${BASE_URL}${path}`);
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(500);
  console.log(JSON.stringify(await page.evaluate(expr), null, 1));
  if (shot) await page.screenshot({ path: shot });
  await browser.close();
}
void main();
