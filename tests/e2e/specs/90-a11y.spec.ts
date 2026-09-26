/**
 * axe-core (WCAG 2.1 A + AA rules) on every major page, per role. Serious/critical violations fail the test
 * (soft assertions: every page is still analysed). Per-page JSON lands in tests/e2e/artifacts/a11y/.
 */
import type { Page } from '@playwright/test';
import { axe, seriousOrCritical } from '../lib/a11y';
import type { DevUser } from '../lib/auth';
import { expect, test } from '../lib/fixtures';
import { getState } from '../lib/state';

async function firstId(page: Page, path: string): Promise<string | undefined> {
  const r = await page.request.get(`/api/v1${path}`);
  if (!r.ok()) return undefined;
  const j = (await r.json()) as { items?: Array<{ id: string }> };
  return j.items?.[0]?.id;
}

async function check(page: Page, name: string, testInfo: Parameters<Parameters<typeof test>[2]>[1]) {
  const s = await axe(page, name, testInfo);
  expect.soft(seriousOrCritical(s), `serious/critical axe violations on ${name}`).toEqual([]);
}

type PageSpec = { name: string; path: string | ((page: Page) => Promise<string | undefined>); tabs?: boolean };

const PAGES: Array<{ user: DevUser; pages: PageSpec[] }> = [
  {
    user: 'io.meera',
    pages: [
      { name: 'dashboard (IO)', path: '/' },
      { name: 'evidence list', path: '/evidence' },
      { name: 'evidence detail', path: async () => (getState('evidenceA') ? `/evidence/${getState('evidenceA')}` : undefined), tabs: true },
      { name: 'player', path: async () => (getState('evidenceA') ? `/evidence/${getState('evidenceA')}/player` : undefined) },
      { name: 'upload', path: '/upload' },
      { name: 'upload history', path: '/uploads' },
      { name: 'search', path: '/search' },
      { name: 'cases', path: '/cases' },
      { name: 'case detail', path: async (p) => ((await firstId(p, '/cases?pageSize=1')) ? `/cases/${await firstId(p, '/cases?pageSize=1')}` : undefined), tabs: true },
      { name: 'firs', path: '/firs' },
      { name: 'workspaces', path: '/workspaces' },
      { name: 'workspace detail', path: async (p) => ((await firstId(p, '/workspaces?pageSize=1')) ? `/workspaces/${await firstId(p, '/workspaces?pageSize=1')}` : undefined), tabs: true },
      { name: 'exports', path: '/exports' },
      { name: 'export new', path: '/exports/new' },
      { name: 'export verify', path: '/exports/verify' },
      { name: 'shares', path: '/shares' },
      { name: 'notifications', path: '/notifications' },
      { name: 'profile', path: '/profile' },
    ],
  },
  {
    user: 'sup.kavya',
    pages: [
      { name: 'dashboard (supervisor)', path: '/' },
      { name: 'review queue', path: '/review' },
      { name: 'quarantine', path: '/uploads/quarantine' },
      { name: 'disposal approvals', path: '/evidence/disposals' },
      { name: 'alerts', path: '/alerts' },
      { name: 'alert rules', path: '/alerts/rules' },
      { name: 'reports', path: '/reports' },
      { name: 'export detail', path: async (p) => ((await firstId(p, '/exports?view=all&pageSize=1')) ? `/exports/${await firstId(p, '/exports?view=all&pageSize=1')}` : undefined) },
      { name: 'share detail', path: async (p) => ((await firstId(p, '/shares?pageSize=1')) ? `/shares/${await firstId(p, '/shares?pageSize=1')}` : undefined) },
    ],
  },
  {
    user: 'admin',
    pages: [
      { name: 'dashboard (admin)', path: '/' },
      { name: 'system health', path: '/system/health' },
      { name: 'users', path: '/admin/users' },
      { name: 'user new', path: '/admin/users/new' },
      { name: 'user detail', path: async (p) => ((await firstId(p, '/users?pageSize=1')) ? `/admin/users/${await firstId(p, '/users?pageSize=1')}` : undefined) },
      { name: 'roles', path: '/admin/roles' },
      { name: 'role detail', path: async (p) => ((await firstId(p, '/roles?pageSize=1')) ? `/admin/roles/${await firstId(p, '/roles?pageSize=1')}` : undefined) },
      { name: 'org units', path: '/admin/org' },
      { name: 'devices', path: '/admin/devices' },
      { name: 'settings', path: '/admin/settings' },
      { name: 'integrations', path: '/admin/integrations' },
      { name: 'api clients', path: '/admin/api-clients' },
      { name: 'ai models', path: '/ai/models' },
      { name: 'retention policies', path: '/retention/policies' },
      { name: 'access denied', path: '/review' },
    ],
  },
  {
    user: 'aud.suresh',
    pages: [
      { name: 'audit log', path: '/compliance/audit' },
      { name: 'ledger', path: '/compliance/ledger' },
    ],
  },
  { user: 'fa.naveen', pages: [{ name: 'watchlists', path: '/ai/watchlists' }] },
];

test('login page', async ({ page }, testInfo) => {
  await page.goto('/login');
  await check(page, 'login', testInfo);
});

test('share portal (external)', async ({ anon }, testInfo) => {
  const url = getState<string>('externalShareUrl');
  test.skip(!url, 'no external share created in this run (09-share spec)');
  const page = await anon();
  await page.goto(url!);
  await check(page, 'share portal', testInfo);
});

for (const group of PAGES) {
  test(`pages as ${group.user}`, async ({ as, guard }, testInfo) => {
    test.setTimeout(600_000);
    guard.expectFailure(/\/api\/v1\/(ai\/review|review)/, 403); // access-denied probe (admin on /review)
    const page = await as(group.user);
    for (const spec of group.pages) {
      const path = typeof spec.path === 'string' ? spec.path : await spec.path(page);
      if (!path) {
        testInfo.annotations.push({ type: 'skipped-page', description: `${spec.name}: no data` });
        continue;
      }
      await page.goto(path);
      await expect(page.getByRole('main')).toBeVisible();
      await check(page, spec.name, testInfo);
      if (spec.tabs) {
        const tabs = page.getByRole('tablist').first().getByRole('tab');
        const n = await tabs.count();
        for (let i = 1; i < n; i++) {
          const label = (await tabs.nth(i).textContent())?.trim() ?? String(i);
          await tabs.nth(i).click();
          await check(page, `${spec.name} — ${label}`, testInfo);
        }
      }
    }
  });
}
