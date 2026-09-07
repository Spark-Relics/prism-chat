import type { OutboxJob, OutboxQueue } from "./queue.js";

/**
 * Simple in-process outbox queue with delayed retry scheduling.
 * Adequate for single-instance deployments and development; use a Redis
 * backed queue for multi-instance or crash-safe delivery.
 */
export class MemoryOutboxQueue implements OutboxQueue {
  private handler: ((job: OutboxJob) => Promise<void>) | null = null;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private pending: Array<{ job: OutboxJob; runAt: number }> = [];
  private running = false;
  private drainTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  enqueue(job: OutboxJob): Promise<void> {
    this.pending.push({ job, runAt: Date.now() });
    return Promise.resolve();
  }

  consume(handler: (job: OutboxJob) => Promise<void>): void {
    this.handler = handler;
    this.drainTimer = setInterval(() => void this.drain(), 200);
    // Never keep the process alive just for the drain loop.
    this.drainTimer.unref?.();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.drainTimer) clearInterval(this.drainTimer);
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.pending = [];
  }

  private async drain(): Promise<void> {
    if (this.running || !this.handler || this.closed) return;
    this.running = true;
    try {
      const now = Date.now();
      const due = this.pending.filter((e) => e.runAt <= now);
      if (due.length > 0) {
        this.pending = this.pending.filter((e) => e.runAt > now);
      }
      for (const entry of due) {
        if (!this.handler) break;
        try {
          await this.handler(entry.job);
        } catch {
          // Handler is responsible for retry bookkeeping; swallow here.
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** Used by the pipeline to schedule a retry with backoff. */
  scheduleRetry(job: OutboxJob, delayMs: number): void {
    if (this.closed) return;
    const t = setTimeout(() => {
      this.timers.delete(job.id);
      this.pending.push({ job, runAt: Date.now() });
    }, delayMs);
    this.timers.set(job.id, t);
  }
}
