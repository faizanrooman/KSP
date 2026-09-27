/**
 * Regression coverage for the UI/UX audit A findings (docs/UI-AUDIT-A.md): dialog body scroll lock, focus return and
 * focus retention while typing, internal dialog scrolling, tabs not hidden sideways, mobile drawer behaviour,
 * full-page player fitting the viewport, no page-wide horizontal scroll from table header text, search filter
 * validation focusing the offending field.
 */
import { makeClip } from '../lib/media';
import { expect, test } from '../lib/fixtures';
import { getState, runId } from '../lib/state';

const evidenceA = () => getState<string>('evidenceA');

test('dialogs lock the page, close with Escape and return focus to the opener (UXA-02/03)', async ({ as }) => {
  test.skip(!evidenceA(), 'needs evidence from 02-upload');
  const page = await as('io.meera', { context: { viewport: { width: 1366, height: 768 } } });
  await page.goto(`/evidence/${evidenceA()}`);
  for (const [button, dialog] of [['Add to workspace', /Add to investigation workspace/], ['Link to case', /^Link .* to a case$/]] as const) {
    const opener = page.getByRole('button', { name: button, exact: true });
    await opener.click();
    const dlg = page.getByRole('dialog', { name: dialog });
    await expect(dlg).toBeVisible();
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden');
    await page.mouse.move(5, 400);
    await page.mouse.wheel(0, 800);
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => window.scrollY), 'page behind the dialog must not scroll').toBe(0);
    await page.keyboard.press('Escape');
    await expect(dlg).toBeHidden();
    await expect(opener).toBeFocused();
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
  }
});

test('evidence tabs all stay visible at 1024 px (wrap, not clipped) (UXA-05)', async ({ as }) => {
  test.skip(!evidenceA(), 'needs evidence from 02-upload');
  const page = await as('io.meera', { context: { viewport: { width: 1024, height: 768 } } });
  await page.goto(`/evidence/${evidenceA()}?tab=lifecycle`);
  await expect(page.getByRole('tab', { name: 'Lifecycle' })).toHaveAttribute('aria-selected', 'true');
  const clipped = await page.getByRole('tab').evaluateAll((tabs) =>
    tabs.filter((t) => {
      const b = t.getBoundingClientRect();
      const l = t.parentElement!.getBoundingClientRect();
      return b.right > l.right + 1 || b.left < l.left - 1;
    }).length);
  expect(clipped).toBe(0);
});

test('full-page player controls are visible without scrolling at 1366×768 (UXA-06)', async ({ as }) => {
  test.skip(!evidenceA(), 'needs evidence from 02-upload');
  const page = await as('io.meera', { context: { viewport: { width: 1366, height: 768 } } });
  await page.goto(`/evidence/${evidenceA()}/player`);
  const play = page.getByRole('button', { name: 'Play', exact: true });
  await expect(play).toBeVisible();
  const b = (await play.boundingBox())!;
  expect(b.y + b.height).toBeLessThanOrEqual(768);
});

test('768 px drawer: Escape closes it, page behind locked, focus back on the menu button (UXA-08)', async ({ as }) => {
  const page = await as('io.meera', { context: { viewport: { width: 768, height: 700 } } });
  await page.goto('/evidence');
  const menu = page.getByRole('button', { name: 'Open menu' });
  await menu.click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden();
  await expect(menu).toBeFocused();
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
});

test('upload Details dialog: typing in a later field keeps focus; dialog fits the viewport (UXA-01)', async ({ as }) => {
  const clip = makeClip(`uxa-details-${runId()}`, { seconds: 2 });
  const page = await as('op.cubbon', { context: { viewport: { width: 1366, height: 768 } } });
  await page.goto('/upload');
  await page.getByLabel('Choose files').setInputFiles(clip);
  const item = page.getByRole('list', { name: 'Upload queue' }).getByRole('listitem').first();
  await item.getByRole('button', { name: 'Details', exact: true }).click();
  const dlg = page.getByRole('dialog', { name: /^Details — / });
  await dlg.getByLabel('Category').click();
  await page.keyboard.type('PATROL');
  await expect(dlg.getByLabel('Category')).toHaveValue('PATROL');
  await expect(dlg.getByLabel('Title')).toHaveValue('');
  const save = (await dlg.getByRole('button', { name: 'Save' }).boundingBox())!;
  expect(save.y + save.height, 'footer stays inside the viewport').toBeLessThanOrEqual(768);
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  await item.getByRole('button', { name: /^Remove / }).click();
  await expect(page.getByRole('list', { name: 'Upload queue' })).toHaveCount(0);
});

test('search: an invalid advanced filter focuses and marks the offending field (UXA-15)', async ({ as }) => {
  const page = await as('io.meera');
  await page.goto('/search');
  await page.getByRole('button', { name: 'Filters', exact: true }).click();
  await page.getByLabel('FIR year').fill('2026');
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect(page.getByLabel('FIR number')).toBeFocused();
  await expect(page.getByLabel('FIR number')).toHaveAttribute('aria-invalid', 'true');
});

test('AI models at 1024 px: table header text does not widen the page (UXA-09)', async ({ as }) => {
  const page = await as('admin', { context: { viewport: { width: 1024, height: 768 } } });
  await page.goto('/ai/models');
  await expect(page.getByRole('table').first()).toBeVisible();
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over).toBe(0);
});
