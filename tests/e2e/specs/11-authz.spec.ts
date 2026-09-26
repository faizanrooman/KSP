/**
 * Scenario 11 — authorisation as experienced in the UI: out-of-jurisdiction evidence URL → not-found page (API 404,
 * never 403); role-appropriate navigation; direct URL to an admin page → access-denied page.
 */
import { expect, test } from '../lib/fixtures';
import { getState } from '../lib/state';

test('IO of another station cannot open the evidence (not-found page, 404 not 403)', async ({ as, guard }) => {
  test.skip(!getState('evidenceB'), 'needs 02-upload');
  guard.expectFailure(/\/api\/v1\/evidence\/[0-9a-f-]{36}(\/.*)?$/, 404);
  const statuses: number[] = [];
  const page = await as('io.arjun');
  page.on('response', (r) => {
    if (r.url().endsWith(`/api/v1/evidence/${getState('evidenceB')}`)) statuses.push(r.status());
  });
  await page.goto(`/evidence/${getState('evidenceB')}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Evidence not found' })).toBeVisible();
  await expect(page.getByText('It does not exist or is outside your jurisdiction.')).toBeVisible();
  expect(statuses).toContain(404);
  expect(statuses).not.toContain(403);
  // Nothing of the item leaks into the page.
  await expect(page.getByRole('main')).not.toContainText(getState<string>('titleB')!);
  // Search does not reveal it either.
  await page.goto('/search');
  await page.getByLabel('Search text').fill(getState<string>('titleB')!);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Results' })).not.toContainText(getState<string>('titleB')!);
});

test('field officer navigation hides admin, analysis and case items', async ({ as }) => {
  const page = await as('fo.ravi');
  const nav = page.getByRole('navigation', { name: 'Main' });
  for (const hidden of ['Users', 'Roles & permissions', 'System settings', 'System health', 'AI review queue', 'Cases', 'Court exports', 'Audit log', 'Search']) {
    await expect(nav.getByRole('link', { name: hidden, exact: true })).toHaveCount(0);
  }
  await expect(nav.getByRole('link', { name: 'Upload evidence' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'My profile' })).toBeVisible();
});

test('direct URL to admin pages shows access denied', async ({ as }) => {
  const page = await as('fo.ravi');
  for (const url of ['/admin/users', '/admin/settings', '/system/health', '/review', '/compliance/audit']) {
    await page.goto(url);
    await expect(page.getByRole('heading', { level: 1, name: 'Access denied' }), url).toBeVisible();
  }
  await page.goto('/no/such/page');
  await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
});
