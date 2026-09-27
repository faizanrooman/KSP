/**
 * AI worker observability (FN-3): Prometheus metrics on METRICS_HOST:METRICS_PORT+2 and the 30 s service heartbeat
 * row in worker_heartbeats (service `ksp-ai-worker`; ksp_ai holds SELECT/INSERT/UPDATE on that table only).
 *
 *   ksp_ai_jobs_processed_total{outcome}            COMPLETED | FAILED | CANCELLED
 *   ksp_ai_job_duration_seconds                      claim → finish
 *   ksp_ai_frames_processed_total                    sampled frames analysed (rate() = frames/s)
 *   ksp_ai_last_job_frames_per_second                throughput of the most recent job
 *   ksp_ai_inference_duration_seconds{model,task}    per-frame inference time per model
 *   ksp_ai_queue_claim_latency_seconds               QUEUED → claimed (queue wait)
 *   ksp_ai_jobs_running                              jobs in progress in this process
 *   ksp_ai_worker_heartbeat_timestamp_seconds        last successful heartbeat write
 */
import { createServer, type Server } from 'node:http';
import { hostname } from 'node:os';
import client from 'prom-client';
import { HEARTBEAT_INTERVAL_MS, writeHeartbeat, type Database, type HeartbeatIdentity } from '@ksp/core';

export const registry = new client.Registry();
let defaultsCollected = false;

export const aiMetrics = {
  jobs: new client.Counter({ name: 'ksp_ai_jobs_processed_total', help: 'AI jobs finished by this worker, by outcome', labelNames: ['outcome'], registers: [registry] }),
  jobDuration: new client.Histogram({ name: 'ksp_ai_job_duration_seconds', help: 'AI job run time (claim to finish)', buckets: [1, 5, 15, 60, 300, 900, 3600, 4 * 3600], registers: [registry] }),
  frames: new client.Counter({ name: 'ksp_ai_frames_processed_total', help: 'Sampled frames analysed', registers: [registry] }),
  lastFps: new client.Gauge({ name: 'ksp_ai_last_job_frames_per_second', help: 'Frames per second of the most recently finished job', registers: [registry] }),
  inference: new client.Histogram({ name: 'ksp_ai_inference_duration_seconds', help: 'Per-frame inference time by model', labelNames: ['model', 'task'], buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5], registers: [registry] }),
  claimLatency: new client.Histogram({ name: 'ksp_ai_queue_claim_latency_seconds', help: 'Time an AI job waited in QUEUED before being claimed', buckets: [0.1, 1, 5, 15, 60, 300, 900, 3600, 4 * 3600], registers: [registry] }),
  running: new client.Gauge({ name: 'ksp_ai_jobs_running', help: 'AI jobs currently running in this process', registers: [registry] }),
  heartbeat: new client.Gauge({ name: 'ksp_ai_worker_heartbeat_timestamp_seconds', help: 'Unix time of the last successful heartbeat write', registers: [registry] }),
};

/** Process-local counters reported in the heartbeat `info`. */
export const aiStats = { jobsProcessed: 0, jobsFailed: 0, running: 0, lastJobAt: null as string | null };

export function jobStarted(queueWaitSeconds?: number): void {
  if (queueWaitSeconds !== undefined) aiMetrics.claimLatency.observe(Math.max(0, Number(queueWaitSeconds)));
  aiStats.running++;
  aiMetrics.running.set(aiStats.running);
}

export function recordJob(outcome: string, seconds: number, frames: number): void {
  aiStats.running = Math.max(0, aiStats.running - 1);
  aiMetrics.running.set(aiStats.running);
  aiMetrics.jobs.inc({ outcome });
  aiMetrics.jobDuration.observe(seconds);
  if (seconds > 0 && frames > 0) aiMetrics.lastFps.set(frames / seconds);
  aiStats.jobsProcessed++;
  if (outcome === 'FAILED') aiStats.jobsFailed++;
  aiStats.lastJobAt = new Date().toISOString();
}

export function aiHeartbeatIdentity(): HeartbeatIdentity {
  const host = hostname();
  return { id: `ksp-ai-worker:${host}:${process.pid}`, service: 'ksp-ai-worker', hostname: host, pid: process.pid, version: process.env.KSP_VERSION ?? process.env.npm_package_version, startedAt: new Date() };
}

/** Write the heartbeat now and every HEARTBEAT_INTERVAL_MS; returns a stop function. Failures are logged, never fatal. */
export function startAiHeartbeat(db: Database, info: () => Record<string, unknown>, log?: { warn: (o: object, m: string) => void }, who = aiHeartbeatIdentity(), intervalMs = HEARTBEAT_INTERVAL_MS): { stop: () => void; beat: () => Promise<void> } {
  const beat = async () => {
    try {
      await writeHeartbeat(db, who, { ...aiStats, ...info(), uptimeSeconds: Math.round(process.uptime()) });
      aiMetrics.heartbeat.set(Date.now() / 1000);
    } catch (e) {
      log?.warn({ err: (e as Error).message }, 'AI worker heartbeat write failed');
    }
  };
  void beat();
  const t = setInterval(() => void beat(), intervalMs);
  t.unref();
  return { stop: () => clearInterval(t), beat };
}

/** Internal Prometheus endpoint (never exposed through the ingress). */
export function startMetricsServer(port: number, host: string): Promise<Server> {
  if (!defaultsCollected) {
    client.collectDefaultMetrics({ prefix: 'ksp_ai_worker_', register: registry });
    defaultsCollected = true;
  }
  const srv = createServer(async (req, res) => {
    if (req.url !== '/metrics' && req.url !== '/') {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader('content-type', registry.contentType);
    res.end(await registry.metrics());
  });
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(port, host, () => resolve(srv));
  });
}
