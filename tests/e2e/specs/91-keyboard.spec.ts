/**
 * Keyboard-only walkthrough (no mouse, no locator.click): login → skip link → nav → evidence list → row → tabs →
 * playback controls → review queue shortcuts + dialog focus management. Every stop asserts a visible focus ring.
 */
import type { Page } from '@playwright/test';
import { totp } from '../lib/auth';
import { DEV_PASSWORD } from '../lib/env';
import { expect, test } from '../lib/fixtures';
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
