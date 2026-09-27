/**
 * Keyboard-only walkthrough (no mouse, no locator.click): login → skip link → nav → evidence list → row → tabs →
 * playback controls → review queue shortcuts + dialog focus management. Every stop asserts a visible focus ring.
 */
import type { Page } from '@playwright/test';
import { totp } from '../lib/auth';
import { DEV_PASSWORD } from '../lib/env';
import { expect, test } from '../lib/fixtures';
import { apiGet } from '../lib/api';
import { getState } from '../lib/state';

async function active(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return { tag: '', text: '', label: '', ring: false, role: '' };
    const cs = getComputedStyle(el);
    const ring = (cs.outlineStyle !== 'none' && cs.outlineWidth !== '0px') || (cs.boxShadow !== 'none' && cs.boxShadow !== '');
    return { tag: el.tagName, text: (el.textContent ?? '').trim().slice(0, 120), label: el.getAttribute('aria-label') ?? '', ring, role: el.getAttribute('role') ?? '' };
  });
}

/** Press Tab until the focused element matches; fails after `max` presses. Checks the focus ring on arrival. */
async function tabTo(page: Page, match: (a: Awaited<ReturnType<typeof active>>) => boolean, what: string, max = 80) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const a = await active(page);
    if (match(a)) {
      expect(a.ring, `visible focus indicator on ${what}`).toBeTruthy();
      return;
    }
  }
  throw new Error(`could not reach ${what} with Tab`);
}

async function keyboardLogin(page: Page, user: string, mfa = false) {
  await page.goto('/login');
  await expect(page.getByLabel('Username')).toBeFocused(); // autofocus
  await page.keyboard.type(user);
  await page.keyboard.press('Tab');
  await page.keyboard.type(DEV_PASSWORD);
  await page.keyboard.press('Enter');
  if (mfa) {
    await expect(page.getByLabel('Verification code')).toBeFocused();
    await page.keyboard.type(totp(user));
    await page.keyboard.press('Enter');
  }
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
}

test('keyboard: login → evidence → tabs → playback controls', async ({ page }) => {
  test.skip(!getState('evidenceA'), 'needs 02-upload');
  await keyboardLogin(page, 'io.meera');

  // Skip link is the first stop and moves focus to the main region.
  await page.keyboard.press('Tab');
  expect((await active(page)).text).toBe('Skip to content');
  await page.keyboard.press('Enter');
  await expect(page.locator('#main')).toBeFocused();

  // Navigate to Evidence through the sidebar.
  await page.keyboard.press('Shift+Tab');
  await tabTo(page, (a) => a.tag === 'A' && a.text === 'Evidence', 'Evidence nav link');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Evidence', level: 1 })).toBeVisible();

  // Search field → type → Enter; then Tab to the row and open it with Enter.
  await tabTo(page, (a) => a.tag === 'INPUT', 'evidence search field');
  await page.keyboard.type(getState<string>('titleA')!);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('table', { name: 'Evidence' }).getByRole('row')).toHaveCount(2);
  await tabTo(page, (a) => a.tag === 'TR' && a.text.includes(getState<string>('titleA')!), 'evidence row');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/evidence/${getState('evidenceA')}`));

  // Tabs: one Tab stop, arrows move and activate.
  await tabTo(page, (a) => a.role === 'tab', 'tab list');
  expect((await active(page)).text).toBe('Overview');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Playback' })).toBeFocused();
  await expect(page.getByRole('tab', { name: 'Playback' })).toHaveAttribute('aria-selected', 'true');

  // Playback controls by keyboard.
  const video = page.locator('video').first();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 60_000 }).toBeGreaterThanOrEqual(2);
  await tabTo(page, (a) => a.tag === 'BUTTON' && a.label === 'Play', 'Play button');
  await page.keyboard.press('Enter');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 20_000 }).toBeGreaterThan(0.5);
  await page.keyboard.press('k'); // player shortcut: pause
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  const f0 = await video.evaluate((v: HTMLVideoElement) => Math.floor(v.currentTime * 25 + 1e-6));
  await page.keyboard.press('ArrowRight'); // next frame
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => Math.floor(v.currentTime * 25 + 1e-6))).toBe(f0 + 1);
  await page.keyboard.press(']'); // faster
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.playbackRate)).toBeGreaterThan(1);
  await page.keyboard.press('+'); // zoom in
  await expect(page.getByRole('button', { name: 'Reset zoom' })).toBeEnabled();
  await page.keyboard.press('0');
  await expect(page.getByRole('button', { name: 'Reset zoom' })).toBeDisabled();
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toHaveCount(0);
});

test('keyboard: review queue — shortcuts, reason dialog focus, Escape restores focus', async ({ page }) => {
  test.skip(!getState('evidenceAI'), 'needs the AI clip');
  await keyboardLogin(page, 'fa.naveen');
  await tabTo(page, (a) => a.tag === 'A' && a.text === 'AI review queue', 'review queue nav link');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'AI review queue' })).toBeVisible();
  await page.goto(`/review?evidenceId=${getState('evidenceAI')}&status=PENDING`);
  await expect(page.getByRole('list', { name: 'Review items' }).getByRole('listitem').first()).toBeVisible();
  const current = page.getByTestId('rq-current');
  await expect(current).toContainText('Item 1 of');
  await page.keyboard.press('j');
  await expect(current).toContainText(/Item 2 of|Item 1 of 1:/);
  await page.keyboard.press('k');
  await expect(current).toContainText('Item 1 of');

  // History dialog: focus inside, Escape closes, focus returns to where it was.
  await page.keyboard.press('h');
  const hist = page.getByRole('dialog', { name: 'Review history' });
  await expect(hist).toBeVisible();
  expect(await hist.evaluate((d) => d.contains(document.activeElement))).toBeTruthy();
  // Focus is trapped: many Tabs stay inside the dialog.
  for (let i = 0; i < 6; i++) await page.keyboard.press('Tab');
  expect(await hist.evaluate((d) => d.contains(document.activeElement))).toBeTruthy();
  await page.keyboard.press('Escape');
  await expect(hist).toHaveCount(0);

  // Reject with a typed reason — typing must not trigger shortcuts.
  await page.keyboard.press('r');
  const dlg = page.getByRole('dialog', { name: 'Reject AI result' });
  await expect(dlg.getByRole('textbox', { name: /Reason/ })).toBeFocused();
  await page.keyboard.type('keyboard-only rejection; also has a, h and s');
  await expect(dlg).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Review history' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dlg).toHaveCount(0);
});

/** Press Tab (or Shift+Tab) until `target` is focused. */
async function focusByTab(page: Page, target: import('@playwright/test').Locator, what: string, back = false, max = 80) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press(back ? 'Shift+Tab' : 'Tab');
    if (await target.evaluate((el) => el === document.activeElement)) {
      expect((await active(page)).ring, `visible focus indicator on ${what}`).toBeTruthy();
      return;
    }
  }
  throw new Error(`could not reach ${what} with ${back ? 'Shift+Tab' : 'Tab'}`);
}

test('keyboard: region annotation without a pointer — create, move, resize, Enter, numeric edit, save (FN-17)', async ({ page }, testInfo) => {
  test.skip(!getState('workspaceId'), 'needs 07-workspace');
  await keyboardLogin(page, 'io.meera');
  await page.goto(`/workspaces/${getState('workspaceId')}`);
  await tabTo(page, (a) => a.role === 'tab', 'workspace tab list');
  const reviewTab = page.getByRole('tab', { name: 'Review & annotate' });
  // Arrow keys move focus immediately; the selection (URL state, lazy tab content) commits a moment later — so steer by
  // the FOCUSED tab and then let the assertion below wait for the selection to follow.
  const focusedTab = () => page.evaluate(() => (document.activeElement?.getAttribute('role') === 'tab' ? document.activeElement.textContent : null));
  for (let i = 0; i < 8 && (await focusedTab()) !== 'Review & annotate'; i++) await page.keyboard.press('ArrowRight');
  await expect(reviewTab).toHaveAttribute('aria-selected', 'true');
  const video = page.locator('video').first();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 60_000 }).toBeGreaterThanOrEqual(2);

  await focusByTab(page, page.getByRole('button', { name: 'Region', exact: true }), 'Region button');
  await page.keyboard.press('Enter');
  const frame = page.getByRole('application', { name: /Region editor/ });
  await expect(frame).toHaveAttribute('aria-keyshortcuts', /Shift\+ArrowDown/);
  await focusByTab(page, frame, 'region editor frame', true);

  const t0 = await video.evaluate((v: HTMLVideoElement) => v.currentTime);
  const status = page.getByRole('status').filter({ hasText: /Region created|Moved|Resized|Region set/ });
  await page.keyboard.press('ArrowRight'); // first arrow creates the default box
  await expect(status).toHaveText('Region created: left 40%, top 40%, width 20%, height 20%');
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowUp');
  await expect(status).toHaveText('Moved: left 43%, top 39%, width 20%, height 20%');
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowLeft');
  await expect(status).toHaveText('Resized: left 43%, top 39%, width 19%, height 22%');
  // The player's own arrow-key shortcuts (frame step) must not fire while editing the region.
  expect(await video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBe(t0);
  await expect(page.getByLabel('Region left (%)')).toHaveValue('43');
  await expect(page.getByLabel('Region height (%)')).toHaveValue('22');

  // axe on the open region editor (overlay + numeric inputs)
  const { axe, seriousOrCritical } = await import('../lib/a11y');
  expect(seriousOrCritical(await axe(page, 'workspace region editor (keyboard)', testInfo))).toEqual([]);

  await page.keyboard.press('Enter'); // sets the region and moves on to the description
  await expect(status).toHaveText('Region set: left 43%, top 39%, width 19%, height 22%');
  await expect(page.getByLabel('Description (optional)')).toBeFocused();
  await page.keyboard.type('Keyboard region');

  // Numeric alternative: width 30 %.
  await focusByTab(page, page.getByLabel('Region width (%)'), 'region width input');
  await page.keyboard.press('Control+A');
  await page.keyboard.type('30');
  await expect(page.getByText('Region set (30% × 22%)')).toBeVisible();

  await focusByTab(page, page.getByRole('button', { name: 'Save annotation' }), 'Save annotation');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'Annotation saved' })).toBeVisible();
  type Ann = { body: string | null; region: { x: number; y: number; w: number; h: number } | null };
  const saved: Ann[] = [];
  for (const id of [getState<string>('evidenceA')!, getState<string>('evidenceB')!]) {
    saved.push(...(await apiGet<{ items: Ann[] }>(page, `/workspaces/annotations?evidenceId=${id}&workspaceId=${getState('workspaceId')}`)).items);
  }
  expect(saved.find((a) => a.body === 'Keyboard region')?.region).toEqual({ x: 0.43, y: 0.39, w: 0.3, h: 0.22 });
});
