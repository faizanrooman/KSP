/** FN-3: the AI worker's service heartbeat (as ksp_ai) and Prometheus metrics endpoint, with a real job. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fetchAndRegisterModels } from '../src/models/manifest.js';
import { startAiWorker } from '../src/main.js';
import { appDb, closeAll, evidenceWithProxy, queueJob } from './helpers.js';
import { slideshow, tryEnsureImages } from './media.js';

const MEDIA = await tryEnsureImages();
let stop: Awaited<ReturnType<typeof startAiWorker>> | undefined;

beforeAll(async () => {
  await fetchAndRegisterModels(appDb());
  stop = await startAiWorker({ metricsPort: 0, heartbeatIntervalMs: 250 });
}, 120_000);
afterAll(async () => {
  await stop?.();
  await closeAll();
});

const scrape = async () => {
  const res = await fetch(`http://127.0.0.1:${stop!.metricsPort}/metrics`);
  expect(res.status).toBe(200);
  return res.text();
};
const waitFor = async <T>(fn: () => Promise<T | undefined>, ms = 60_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 200));
  }
};

describe('AI worker observability', () => {
  it('writes a ksp-ai-worker heartbeat row every interval (as ksp_ai) and serves metrics', async () => {
    const first = await waitFor(async () => appDb().selectFrom('worker_heartbeats').selectAll().where('service', '=', 'ksp-ai-worker').where('pid', '=', process.pid).executeTakeFirst());
    expect(first.id).toBe(`ksp-ai-worker:${first.hostname}:${process.pid}`);
    expect(first.info).toMatchObject({ concurrency: 1, running: 0, jobsProcessed: expect.any(Number) });
    const later = await waitFor(async () => {
      const r = await appDb().selectFrom('worker_heartbeats').select('last_seen_at').where('id', '=', first.id).executeTakeFirstOrThrow();
      return r.last_seen_at.getTime() > first.last_seen_at.getTime() ? r : undefined;
    }, 5000);
    expect(later.last_seen_at.getTime()).toBeGreaterThan(first.last_seen_at.getTime());
    const text = await scrape();
    for (const m of ['ksp_ai_jobs_processed_total', 'ksp_ai_frames_processed_total', 'ksp_ai_inference_duration_seconds', 'ksp_ai_queue_claim_latency_seconds', 'ksp_ai_jobs_running', 'ksp_ai_worker_heartbeat_timestamp_seconds', 'ksp_ai_worker_process_cpu_seconds_total']) {
      expect(text).toContain(m);
    }
    expect(Number(/^ksp_ai_worker_heartbeat_timestamp_seconds (\S+)$/m.exec(text)?.[1])).toBeGreaterThan(Date.now() / 1000 - 60);
    expect((await fetch(`http://127.0.0.1:${stop!.metricsPort}/other`)).status).toBe(404);
  });

  it.skipIf(!MEDIA.images)('counts jobs, frames, per-model inference time and queue claim latency for a real job', async () => {
    const i = MEDIA.images!;
    const video = await slideshow([i.street, i.crowd], [2, 2], 'ai-metrics-4s');
    const ev = await evidenceWithProxy(video);
    const jobId = await queueJob(ev, ['PERSON_DETECTION'], { sampleFps: 2 });
    await appDb().selectNoFrom((eb) => eb.fn('pg_notify', [eb.val('ksp_ai_jobs'), eb.val(jobId)]).as('n')).execute();
    const job = await waitFor(async () => {
      const j = await appDb().selectFrom('ai_jobs').select(['status', 'stats']).where('id', '=', jobId).executeTakeFirstOrThrow();
      return ['COMPLETED', 'FAILED'].includes(j.status) ? j : undefined;
    }, 90_000);
    expect(job.status).toBe('COMPLETED');
    const frames = (job.stats as { framesProcessed: number }).framesProcessed;
    await new Promise((r) => setTimeout(r, 300)); // recordJob runs right after the status write
    const text = await scrape();
    expect(Number(/^ksp_ai_jobs_processed_total\{outcome="COMPLETED"\} (\S+)$/m.exec(text)?.[1])).toBeGreaterThanOrEqual(1);
    expect(Number(/^ksp_ai_frames_processed_total (\S+)$/m.exec(text)?.[1])).toBeGreaterThanOrEqual(frames);
    expect(text).toMatch(/^ksp_ai_inference_duration_seconds_count\{model="[^"]+",task="PERSON_DETECTION"\} [1-9]/m);
    expect(Number(/^ksp_ai_queue_claim_latency_seconds_count (\S+)$/m.exec(text)?.[1])).toBeGreaterThanOrEqual(1);
    expect(Number(/^ksp_ai_last_job_frames_per_second (\S+)$/m.exec(text)?.[1])).toBeGreaterThan(0);
    const hb = await waitFor(async () => {
      const r = await appDb().selectFrom('worker_heartbeats').select('info').where('service', '=', 'ksp-ai-worker').where('pid', '=', process.pid).executeTakeFirstOrThrow();
      return (r.info as { jobsProcessed: number }).jobsProcessed >= 1 ? r : undefined;
    }, 5000);
    expect(hb.info).toMatchObject({ jobsProcessed: expect.any(Number), lastJobAt: expect.any(String) });
  }, 120_000);
});
