import type { Database } from '@ksp/core';

/**
 * User-visible processing status (processing_jobs table) wrapped around a queue job execution.
 * pg-boss owns retries; this record shows progress/errors on dashboards and evidence pages.
 */
export class ProcessingTracker {
  private lastWrite = 0;
  constructor(
    private readonly db: Database,
    readonly id: string,
  ) {}

  static async start(db: Database, v: { kind: string; evidenceId?: string | null; uploadSessionId?: string | null; queueJobId?: string }): Promise<ProcessingTracker> {
    // Reuse the row for the same queue job (retries) so attempts accumulate on one record.
    const existing = v.queueJobId
      ? await db.selectFrom('processing_jobs').select('id').where('queue_job_id', '=', v.queueJobId).executeTakeFirst()
      : undefined;
    if (existing) {
      await db
        .updateTable('processing_jobs')
        .set((eb) => ({ status: 'RUNNING', started_at: new Date(), attempts: eb('attempts', '+', 1), error: null }))
        .where('id', '=', existing.id)
        .execute();
      return new ProcessingTracker(db, existing.id);
    }
    const row = await db
      .insertInto('processing_jobs')
      .values({ kind: v.kind, evidence_id: v.evidenceId ?? null, upload_session_id: v.uploadSessionId ?? null, queue_job_id: v.queueJobId ?? null, status: 'RUNNING', attempts: 1, started_at: new Date() })
      .returning('id')
      .executeTakeFirstOrThrow();
    return new ProcessingTracker(db, row.id);
  }

  /** Throttled progress updates (max ~1 write/second). */
  async progress(fraction: number): Promise<void> {
    if (Date.now() - this.lastWrite < 1000 && fraction < 1) return;
    this.lastWrite = Date.now();
    await this.db.updateTable('processing_jobs').set({ progress: Math.max(0, Math.min(1, fraction)) }).where('id', '=', this.id).execute();
  }

  async complete(result?: unknown): Promise<void> {
    await this.db.updateTable('processing_jobs').set({ status: 'COMPLETED', progress: 1, finished_at: new Date(), result: result === undefined ? null : JSON.stringify(result) }).where('id', '=', this.id).execute();
  }

  async fail(err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    await this.db.updateTable('processing_jobs').set({ status: 'FAILED', finished_at: new Date(), error: message.slice(0, 4000) }).where('id', '=', this.id).execute();
  }
}
