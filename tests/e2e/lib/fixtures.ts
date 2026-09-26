/**
 * Shared Playwright fixtures.
 *   guard  (auto) — runtime checks on every context the test uses (see guard.ts); fails the test on problems.
 *   as(user)      — a fresh, isolated browser context signed in as a dev user through the real login UI.
 *   anon()        — a fresh unauthenticated context (e.g. the external share portal).
 */
import { test as base, expect, type BrowserContext, type BrowserContextOptions, type Page } from '@playwright/test';
import { login, type DevUser } from './auth';
import { BASE_URL } from './env';
import { Guard } from './guard';

export interface Fixtures {
  guard: Guard;
  as: (user: DevUser | string, opts?: { password?: string; to?: string; context?: BrowserContextOptions }) => Promise<Page>;
  anon: (opts?: BrowserContextOptions) => Promise<Page>;
}

export const test = base.extend<Fixtures>({
  guard: [
    async ({ context }, use, testInfo) => {
      const g = new Guard();
      g.watch(context);
      await use(g);
      const problems = await g.finish();
      if (problems.length) await testInfo.attach('runtime-problems.json', { body: JSON.stringify(problems, null, 2), contentType: 'application/json' });
      expect(problems, 'no uncaught errors, unexpected failed API requests or storage URLs').toEqual([]);
    },
    { auto: true },
  ],
  as: async ({ browser, guard }, use, testInfo) => {
    const contexts: BrowserContext[] = [];
    await use(async (user, opts = {}) => {
      const ctx = await browser.newContext({ baseURL: BASE_URL, acceptDownloads: true, viewport: { width: 1280, height: 900 }, ...opts.context });
      contexts.push(ctx);
      guard.watch(ctx);
      const page = await ctx.newPage();
      await login(page, user, opts);
      return page;
    });
    for (const c of contexts) {
      if (testInfo.status !== testInfo.expectedStatus) {
        for (const p of c.pages()) await testInfo.attach(`failure-${user(p)}.png`, { body: await p.screenshot({ fullPage: true }).catch(() => Buffer.alloc(0)), contentType: 'image/png' });
      }
      await c.close();
    }
  },
  anon: async ({ browser, guard }, use) => {
    const contexts: BrowserContext[] = [];
    await use(async (opts = {}) => {
      const ctx = await browser.newContext({ baseURL: BASE_URL, acceptDownloads: true, viewport: { width: 1280, height: 900 }, ...opts });
      contexts.push(ctx);
      guard.watch(ctx);
      return ctx.newPage();
    });
    for (const c of contexts) await c.close();
  },
});

function user(p: Page): string {
  return new URL(p.url()).pathname.replace(/[^a-z0-9]+/gi, '_').slice(0, 40) || 'page';
}

export { expect };
