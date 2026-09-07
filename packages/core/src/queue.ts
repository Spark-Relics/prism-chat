/**
 * Pluggable queue interface for outbound reliability.
 * Default: in-memory. Swap with Redis/BullMQ backed implementation without
 * touching core.
 */
export interface OutboxQueue {
  /** Enqueue an outbound job. */
  enqueue(job: OutboxJob): Promise<void>;
  /** Register the consumer that processes jobs. */
  consume(handler: (job: OutboxJob) => Promise<void>): void;
}

export interface OutboxJob {
  id: string;
  channel: string;
  message: import("./types.js").OutboundMessage;
  attempt: number;
  firstQueuedAt: number;
  lastError?: string;
}
