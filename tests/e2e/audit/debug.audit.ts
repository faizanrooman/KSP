/**
 * Ad-hoc probe: AUDIT_USER=admin AUDIT_PATH=/ai/models AUDIT_W=1024 — lists the widest elements that stick out of
 * the viewport (to find what causes horizontal page scroll) and saves a screenshot to .local/ui-audit/debug.png.
 */
import { test } from '@playwright/test';
import { resolve } from 'node:path';
import { login, type DevUser } from '../lib/auth';
import { BASE_URL } from '../lib/env';
import { OUT_DIR, settle } from './lib';

test('probe', async ({ browser }) => {
  const w = Number(process.env.AUDIT_W ?? 1024);
  const ctx = await browser.newContext({ baseURL: BASE_URL, viewport: { width: w, height: Number(process.env.AUDIT_H ?? 768) } });
  const page = await ctx.newPage();
  await login(page, (process.env.AUDIT_USER ?? 'io.meera') as DevUser);
  await page.goto(process.env.AUDIT_PATH ?? '/');
  await settle(page);
  const r = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const out: string[] = [`scrollWidth=${document.documentElement.scrollWidth} vw=${vw}`];
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      const b = el.getBoundingClientRect();
      if (b.right > vw + 1 && b.width) out.push(`${el.tagName} .${(el.getAttribute('class') ?? '').slice(0, 80)} right=${Math.round(b.right)} w=${Math.round(b.width)} "${(el.textContent ?? '').slice(0, 40)}"`);
    }
    return out.slice(0, 30);
  });
  console.log(r.join('\n'));
  await page.screenshot({ path: resolve(OUT_DIR, 'debug.png'), fullPage: process.env.AUDIT_FULL === '1' });
  await ctx.close();
});
