/**
 * Inbox deduplication: platforms redeliver webhooks; business handlers must
 * run exactly once per logical event. Interface allows swapping in Redis
 * (SETNX + TTL) for multi-instance deployments.
 */
export interface InboxDeduplicator {
  /** Return true if this dedupe key was unseen (and now claimed). */
  claim(key: string): Promise<boolean>;
}

/** Bounded in-memory LRU-ish dedupe with TTL. */
export class MemoryInboxDeduplicator implements InboxDeduplicator {
  private readonly map = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(opts?: { ttlMs?: number; maxEntries?: number }) {
    this.ttlMs = opts?.ttlMs ?? 24 * 60 * 60 * 1000;
    this.maxEntries = opts?.maxEntries ?? 100_000;
  }

  async claim(key: string): Promise<boolean> {
    const now = Date.now();
    this.evictExpired(now);
    if (this.map.has(key)) return false;
    this.map.set(key, now);
    if (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    return true;
  }

  private evictExpired(now: number): void {
    if (this.map.size < this.maxEntries / 2) {
      for (const [k, t] of this.map) {
        if (now - t > this.ttlMs) this.map.delete(k);
      }
    }
  }
}
