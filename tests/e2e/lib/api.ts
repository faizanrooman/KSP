/** Small helpers that use the signed-in page's own session (cookies) to read API state while waiting. */
import { expect, type Page } from '@playwright/test';

export async function apiGet<T = Record<string, unknown>>(page: Page, path: string): Promise<T> {
  const r = await page.request.get(`/api/v1${path}`);
  expect(r.ok(), `GET ${path} -> ${r.status()}`).toBeTruthy();
  return (await r.json()) as T;
}

/** Wait until the video pipeline has produced proxy + HLS for the evidence (mediaStatus READY). */
export async function waitForMediaReady(page: Page, evidenceId: string, timeout = 240_000): Promise<void> {
  await expect
    .poll(async () => (await apiGet<{ mediaStatus: string }>(page, `/evidence/${evidenceId}`)).mediaStatus, { timeout, intervals: [2000] })
    .toBe('READY');
}

export async function videoState(page: Page, selector = 'video') {
  return page.locator(selector).first().evaluate((v: HTMLVideoElement) => ({
    t: v.currentTime,
    paused: v.paused,
    rate: v.playbackRate,
    ready: v.readyState,
    duration: v.duration,
    src: v.currentSrc,
    w: v.videoWidth,
  }));
}
