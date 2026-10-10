/**
 * UI/UX audit — interactions (screens of audit A). Each check records PASS/FAIL in
 * .local/ui-audit/<suite>/interact.json and screenshots the state it looked at.
 *   Dialogs on evidence detail: open, internal scroll, body scroll lock, Esc / backdrop / Cancel / X close, focus restore.
 *   Upload: file picker with long/Kannada names, per-file Details dialog keeps focus while typing, pause/resume/cancel.
 *   Mobile drawer (768 px): opens, Esc closes, body locked, drawer scrolls.
 *   Notification bell popover, evidence list pagination + back/forward, tab URL state on reload.
 */
import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { login, type DevUser } from '../lib/auth';
import { BASE_URL, FFMPEG, ROOT } from '../lib/env';
import { OUT_DIR, Recorder, settle } from './lib';

interface Check { name: string; ok: boolean; detail?: string }

test('interactions (audit A)', async ({ browser }) => {
  const suite = process.env.AUDIT_SUITE ?? 'interact';
  const rec = new Recorder(suite);
  const checks: Check[] = [];
  const check = async (name: string, fn: () => Promise<string | void>) => {
    try {
      const detail = await fn();
      checks.push({ name, ok: true, detail: detail || undefined });
    } catch (e) {
      checks.push({ name, ok: false, detail: (e as Error).message.split('\n').slice(0, 8).join(' ').replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'), '') });
    }
  };
  const open = async (user: DevUser, vp = { width: 1366, height: 768 }) => {
    const ctx = await browser.newContext({ baseURL: BASE_URL, viewport: vp });
    rec.watch(ctx);
    const p = await ctx.newPage();
    await login(p, user);
    return p;
  };
  const shot = (p: Page, n: string) => p.screenshot({ path: rec.shot(n) });
  /** Wheel over the dialog backdrop and report whether the page behind moved. */
  const bodyScrollsBehind = async (p: Page) => {
    await p.evaluate(() => window.scrollTo(0, 0));
    await p.mouse.move(5, 300);
    await p.mouse.wheel(0, 600);
    await p.waitForTimeout(300);
    return p.evaluate(() => window.scrollY);
  };

  // ---------------------------------------------------------------- evidence detail dialogs (io.meera)
  const io = await open('io.meera');
  const list = await (await io.request.get('/api/v1/evidence?pageSize=50')).json() as { items: Array<{ id: string; status: string; mediaStatus: string }> };
  const ev = list.items.find((e) => e.status === 'REGISTERED' && e.mediaStatus === 'READY')!;
  await io.goto(`/evidence/${ev.id}`);
  await settle(io);
  for (const [button, dialog] of [
    ['Add to workspace', /Add to investigation workspace/],
    ['Link to case', /^Link .* to a case$/],
    ['Share', /^Share /],
    ['Reprocess media', /Reprocess media/],
  ] as const) {
    await check(`dialog "${button}": opens, locks body, Esc closes, focus returns`, async () => {
      if (button === 'Reprocess media' && !(await io.getByRole('button', { name: button, exact: true }).first().isVisible())) await io.getByRole('button', { name: 'More actions' }).click();
      const opener = io.getByRole('button', { name: button, exact: true }).first();
      await opener.click();
      const dlg = io.getByRole('dialog', { name: dialog });
      await expect(dlg).toBeVisible();
      await shot(io, `dialog-${button}`);
      const box = await dlg.boundingBox();
      const vh = io.viewportSize()!.height;
      if (box && box.y + box.height > vh + 1) throw new Error(`dialog taller than viewport: bottom ${Math.round(box.y + box.height)} > ${vh}`);
      const moved = await bodyScrollsBehind(io);
      await io.keyboard.press('Escape');
      await expect(dlg).toBeHidden();
      await expect(opener).toBeFocused();
      if (moved > 0) throw new Error(`page behind the dialog scrolled by ${moved}px`);
    });
    await check(`dialog "${button}": backdrop click and Close button close it`, async () => {
      await io.getByRole('button', { name: button, exact: true }).first().click();
      const dlg = io.getByRole('dialog', { name: dialog });
      await expect(dlg).toBeVisible();
      await io.mouse.click(3, io.viewportSize()!.height - 3);
      await expect(dlg).toBeHidden();
      await io.getByRole('button', { name: button, exact: true }).first().click();
      await io.getByRole('dialog', { name: dialog }).getByRole('button', { name: 'Close dialog' }).click();
      await expect(dlg).toBeHidden();
    });
  }

  await check('share dialog: user picker list is fully visible inside the dialog', async () => {
    await io.getByRole('button', { name: 'Share', exact: true }).first().click();
    const dlg = io.getByRole('dialog', { name: /^Share / });
    await dlg.getByRole('combobox', { name: 'User' }).fill('a');
    const lb = dlg.getByRole('listbox', { name: 'Matching users' });
    await expect(lb).toBeVisible();
    await shot(io, 'share-user-picker');
    const [l, body] = [await lb.boundingBox(), await dlg.locator('div.overflow-y-auto').first().boundingBox()];
    await io.keyboard.press('Escape');
    await io.keyboard.press('Escape');
    await expect(dlg).toBeHidden();
    if (l && body && l.y + l.height > body.y + body.height + 1) throw new Error(`listbox clipped: bottom ${Math.round(l.y + l.height)} > dialog body ${Math.round(body.y + body.height)}`);
  });

  // Tab URL state survives reload and back/forward.
  await check('evidence tabs: URL state survives reload', async () => {
    await io.getByRole('tab', { name: 'Integrity' }).click();
    await expect(io).toHaveURL(/tab=integrity/);
    await io.reload();
    await expect(io.getByRole('tab', { name: 'Integrity' })).toHaveAttribute('aria-selected', 'true');
  });
  await check('evidence tabs: every tab visible (not scrolled out of view) at 1024 px', async () => {
    await io.setViewportSize({ width: 1024, height: 768 });
    const hidden = await io.getByRole('tab').evaluateAll((tabs) => tabs.filter((t) => {
      const b = t.getBoundingClientRect();
      const l = t.parentElement!.getBoundingClientRect();
      return b.right > l.right + 1 || b.left < l.left - 1;
    }).map((t) => t.textContent));
    await shot(io, 'tabs-1024');
    await io.setViewportSize({ width: 1366, height: 768 });
    if (hidden.length) throw new Error(`tabs clipped: ${hidden.join(', ')}`);
  });

  // Evidence list pagination + back/forward.
  await check('evidence list: pagination next/prev and browser back restore the page', async () => {
    await io.goto('/evidence?pageSize=2');
    await settle(io);
    await expect(io.getByText(/^1–2 of/)).toBeVisible();
    await io.getByRole('button', { name: 'Next page' }).click();
    await expect(io.getByText(/^3–4 of/)).toBeVisible();
    // Open a row from page 2, then browser Back: the list must come back on page 2.
    await io.getByRole('table', { name: 'Evidence' }).getByRole('row').nth(1).click();
    await expect(io).toHaveURL(/\/evidence\/[0-9a-f-]{36}/);
    await io.goBack();
    await expect(io.getByText(/^3–4 of/)).toBeVisible();
    await io.goForward();
    await expect(io).toHaveURL(/\/evidence\/[0-9a-f-]{36}/);
    await io.goBack();
    await io.getByRole('button', { name: 'Previous page' }).click();
    await expect(io.getByText(/^1–2 of/)).toBeVisible();
  });
  await check('evidence list: fits 1366 px without horizontal table scroll', async () => {
    await io.goto('/evidence');
    await settle(io);
    const over = await io.locator('table').first().evaluate((t) => t.parentElement!.scrollWidth - t.parentElement!.clientWidth);
    await shot(io, 'evidence-list-1366');
    if (over > 1) throw new Error(`table overflows its card by ${over}px`);
  });

  // Notification bell popover.
  await check('notification bell: opens, Esc and outside click close', async () => {
    const bell = io.getByRole('button', { name: /^Notifications:/ });
    await bell.click();
    await expect(io.getByRole('dialog', { name: 'Unread notifications' })).toBeVisible();
    await io.keyboard.press('Escape');
    await expect(io.getByRole('dialog', { name: 'Unread notifications' })).toBeHidden();
    await bell.click();
    await io.mouse.click(700, 500);
    await expect(io.getByRole('dialog', { name: 'Unread notifications' })).toBeHidden();
  });

  // Full-page player fits the viewport (controls reachable without scrolling).
  for (const vp of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }, { width: 1024, height: 768 }]) {
    await check(`full-page player: controls visible without scrolling at ${vp.width}×${vp.height}`, async () => {
      await io.setViewportSize(vp);
      await io.goto(`/evidence/${ev.id}/player`);
      await expect(io.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
      await io.waitForTimeout(500);
      const b = await io.getByRole('button', { name: 'Play', exact: true }).boundingBox();
      await shot(io, `player-${vp.width}`);
      if (!b || b.y + b.height > vp.height) throw new Error(`Play button at y=${b && Math.round(b.y)} is below the fold (${vp.height})`);
    });
  }
  await io.setViewportSize({ width: 1366, height: 768 });

  // Mobile drawer.
  await check('768 px drawer: opens, body locked, scrolls, Esc closes and returns focus', async () => {
    await io.setViewportSize({ width: 768, height: 600 });
    await io.goto('/evidence');
    await settle(io);
    const menu = io.getByRole('button', { name: 'Open menu' });
    await menu.click();
    const nav = io.getByRole('navigation', { name: 'Main' });
    await expect(nav).toBeVisible();
    await shot(io, 'drawer-768');
    const scroller = nav.locator('div.overflow-y-auto');
    const canScroll = await scroller.evaluate((el) => el.scrollHeight > el.clientHeight);
    if (canScroll) {
      await scroller.hover();
      await io.mouse.wheel(0, 400);
      await io.waitForTimeout(200);
      const top = await scroller.evaluate((el) => el.scrollTop);
      if (top === 0) throw new Error('drawer list does not scroll');
    }
    const bodyY = await io.evaluate(() => window.scrollY);
    if (bodyY > 0) throw new Error(`page behind drawer scrolled by ${bodyY}`);
    await io.keyboard.press('Escape');
    await expect(nav).toBeHidden();
    await expect(menu).toBeFocused();
  });
  await io.setViewportSize({ width: 1366, height: 768 });

  // Workspace create dialog: invalid (empty) then valid; Cancel.
  await check('new workspace dialog: Create disabled until a title is typed; Cancel closes', async () => {
    await io.goto('/workspaces');
    await io.getByRole('button', { name: 'New workspace' }).click();
    const dlg = io.getByRole('dialog', { name: 'New investigation workspace' });
    await expect(dlg.getByRole('button', { name: 'Create' })).toBeDisabled();
    await dlg.getByLabel('Title').fill('x');
    await dlg.getByLabel('Description').click();
    await io.keyboard.type('typing keeps focus');
    await expect(dlg.getByLabel('Description')).toHaveValue('typing keeps focus');
    await expect(dlg.getByRole('button', { name: 'Create' })).toBeEnabled();
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    await expect(dlg).toBeHidden();
  });

  // ---------------------------------------------------------------- upload (op.cubbon)
  const op = await open('op.cubbon');
  // Fresh content every run (identical bytes would be quarantined as DUPLICATE): landscape with a very long name,
  // portrait with a Kannada name, and a 3-minute clip (long enough to pause/resume mid-transfer).
  const media = resolve(ROOT, '.local/audit-media', String(Date.now()));
  mkdirSync(media, { recursive: true });
  const files = ['cctv_mg_road_junction_camera_07_northbound_2026-09-20_very_long_filename_for_overflow_testing.mp4', 'bodycam_portrait_ಬೆಂಗಳೂರು.mp4', 'long_patrol_3min.mp4'];
  const salt = String(Date.now() % 997);
  const gen = (out: string, size: string, secs: number) =>
    execFileSync(FFMPEG, ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=15`, '-f', 'lavfi', '-i', `sine=frequency=${300 + Number(salt)}`,
      '-t', String(secs), '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-metadata', `comment=${salt}`, resolve(media, out)]);
  gen(files[0]!, '1280x720', 20);
  gen(files[1]!, '720x1280', 15);
  gen(files[2]!, '640x360', 180);
  await op.goto('/upload');
  await settle(op);
  await op.getByLabel('Choose files').setInputFiles(files.map((f) => resolve(media, f)));
  const queue = op.getByRole('list', { name: 'Upload queue' });
  await expect(queue.getByRole('listitem')).toHaveCount(3);
  await check('upload queue: long file names do not overflow at 1366 and 768 px', async () => {
    for (const w of [1366, 768]) {
      await op.setViewportSize({ width: w, height: 900 });
      await op.waitForTimeout(200);
      const over = await op.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      await queue.scrollIntoViewIfNeeded();
      await shot(op, `upload-queue-${w}`);
      if (over > 0) throw new Error(`horizontal page scroll ${over}px at ${w}`);
    }
    await op.setViewportSize({ width: 1366, height: 768 });
  });
  await check('upload Details dialog: typing in a later field keeps focus there', async () => {
    await queue.getByRole('listitem').filter({ hasText: 'bodycam' }).getByRole('button', { name: 'Details' }).click();
    const dlg = op.getByRole('dialog', { name: /^Details — / });
    await expect(dlg).toBeVisible();
    await dlg.getByLabel('Category').click();
    await op.keyboard.type('PATROL');
    await shot(op, 'upload-details-dialog');
    await expect(dlg.getByLabel('Category')).toHaveValue('PATROL');
    await expect(dlg.getByLabel('Title')).toHaveValue('');
  });
  await check('upload Details dialog: fits the viewport, body scrolls internally, footer visible', async () => {
    const dlg = op.getByRole('dialog', { name: /^Details — / });
    const b = (await dlg.boundingBox())!;
    const save = await dlg.getByRole('button', { name: 'Save' }).boundingBox();
    if (b.y + b.height > 769) throw new Error(`dialog bottom ${Math.round(b.y + b.height)} > 768`);
    if (!save || save.y + save.height > 768) throw new Error('Save button below the fold');
    await dlg.getByRole('button', { name: 'Save' }).click();
    await expect(dlg).toBeHidden();
  });
  await check('upload: start, pause, resume, cancel, registered', async () => {
    // Throttle the upstream (~1.5 MB/s) so the transfer lasts long enough to pause/resume/cancel mid-way.
    const cdp = await op.context().newCDPSession(op);
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 20, downloadThroughput: 20e6, uploadThroughput: 1.5e6 });
    await op.getByRole('button', { name: /^Start upload/ }).click();
    const longItem = queue.getByRole('listitem').filter({ hasText: 'long_patrol' });
    const pause = op.getByRole('button', { name: 'Pause long_patrol_3min.mp4' });
    await pause.click({ timeout: 30_000 });
    await expect(longItem.getByText('Paused', { exact: true })).toBeVisible();
    await shot(op, 'upload-paused');
    await op.getByRole('button', { name: 'Resume long_patrol_3min.mp4' }).click();
    await expect(longItem.getByText(/^(Uploading|Preparing|Finishing upload|Validating|Registered)$/)).toBeVisible();
    // Cancel it while it is still transferring (it is the largest file); the two others register.
    const cancel = op.getByRole('button', { name: 'Cancel long_patrol_3min.mp4' });
    if (await cancel.isVisible()) {
      await cancel.click();
      await expect(longItem.getByText('Cancelled', { exact: true })).toBeVisible();
    }
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await expect(queue.getByText('Registered', { exact: true })).toHaveCount((await longItem.getByText('Cancelled').count()) ? 2 : 3, { timeout: 300_000 });
    await shot(op, 'upload-done');
  });

  writeFileSync(resolve(OUT_DIR, suite, 'interact.json'), JSON.stringify({ checks, runtime: rec.findings }, null, 2));
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
});
