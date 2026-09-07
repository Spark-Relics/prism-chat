import { EventEmitter } from "node:events";
import type {
  DeliveryResult,
  OutboundMessage,
  PrismMessage,
  WebhookRequest,
  WebhookResult,
} from "./types.js";
import type { ChannelAdapter } from "./adapter.js";
import { ChannelNotFoundError, ConfigurationError, PrismError } from "./errors.js";
import { newId } from "./ids.js";
import type { Logger } from "./logger.js";
import { consoleLogger } from "./logger.js";
import { MemoryInboxDeduplicator } from "./dedupe.js";
import type { InboxDeduplicator } from "./dedupe.js";
import { MemoryOutboxQueue } from "./memory-queue.js";
import type { OutboxJob, OutboxQueue } from "./queue.js";

export interface PrismHubOptions {
  logger?: Logger;
  outbox?: {
    queue?: OutboxQueue;
    maxAttempts?: number;
    /** Base backoff ms, doubled per attempt. */
    baseBackoffMs?: number;
    onDeadLetter?: (job: OutboxJob) => void;
  };
  inbox?: {
    dedupe?: InboxDeduplicator;
  };
}

export type InboundHandler = (message: PrismMessage) => void | Promise<void>;

export interface DeadLetterEntry {
  job: OutboxJob;
  error: unknown;
}

/**
 * The hub wires adapters to the delivery pipeline and exposes a tiny
 * surface to business code: send / onMessage / handleWebhook.
 */
export class PrismHub extends EventEmitter {
  private readonly adapters = new Map<string, ChannelAdapter>();
  private readonly logger: Logger;
  private readonly queue: OutboxQueue;
  private readonly memoryQueue: MemoryOutboxQueue | null;
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;
  private readonly dedupe: InboxDeduplicator;
  private readonly handlers = new Set<InboundHandler>();
  private readonly onDeadLetter?: (job: OutboxJob) => void;
  private started = false;
  private stopped = false;

  constructor(opts: PrismHubOptions = {}) {
    super();
    this.logger = opts.logger ?? consoleLogger;
    this.queue = opts.outbox?.queue ?? new MemoryOutboxQueue();
    this.memoryQueue = opts.outbox?.queue ? null : (this.queue as MemoryOutboxQueue);
    this.maxAttempts = opts.outbox?.maxAttempts ?? 5;
    this.baseBackoffMs = opts.outbox?.baseBackoffMs ?? 2000;
    this.dedupe = opts.inbox?.dedupe ?? new MemoryInboxDeduplicator();
    this.onDeadLetter = opts.outbox?.onDeadLetter;
  }

  /** Register an adapter. Call before start(). */
  use(adapter: ChannelAdapter): this {
    if (this.adapters.has(adapter.channel)) {
      throw new ConfigurationError(`Channel "${adapter.channel}" already registered.`);
    }
    this.adapters.set(adapter.channel, adapter);
    return this;
  }

  /** Register a channel lazily through a factory (useful for DI containers). */
  useFactory(create: () => ChannelAdapter): this {
    return this.use(create());
  }

  listChannels(): Array<{ id: string; displayName: string }> {
    return [...this.adapters.values()].map((a) => ({
      id: a.channel,
      displayName: a.displayName,
    }));
  }

  capabilities(channel: string) {
    return this.getAdapter(channel).capabilities();
  }

  /** Subscribe to all inbound messages across channels. */
  onMessage(handler: InboundHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /** Subscribe to messages from a single channel. */
  onChannelMessage(channel: string, handler: InboundHandler): () => void {
    return this.onMessage((m) => {
      if (m.channel === channel) void handler(m);
    });
  }

  /** Start all adapters and the outbox consumer. Idempotent. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.queue.consume((job) => this.processJob(job));
    for (const adapter of this.adapters.values()) {
      await adapter.start({
        logger: this.logger,
        dispatchInbound: (messages) => void this.ingest(messages),
      });
      this.logger.info(`adapter started`, { channel: adapter.channel });
    }
  }

  /** Graceful shutdown. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const adapter of this.adapters.values()) {
      try {
        await adapter.stop();
      } catch (err) {
        this.logger.error(`adapter stop failed`, { channel: adapter.channel, err: String(err) });
      }
    }
    if (this.memoryQueue) await this.memoryQueue.close();
  }

  /** Send an outbound message through the outbox pipeline. */
  async send(message: OutboundMessage): Promise<DeliveryResult> {
    const adapter = this.getAdapter(message.channel);
    void adapter; // validated eagerly, pipeline re-resolves
    const job: OutboxJob = {
      id: newId(),
      channel: message.channel,
      message,
      attempt: 0,
      firstQueuedAt: Date.now(),
    };
    await this.queue.enqueue(job);
    return { status: "queued" };
  }

  /**
   * Fire-and-forget send without the outbox (no retry). Prefer send().
   */
  async sendNow(message: OutboundMessage): Promise<DeliveryResult> {
    const adapter = this.getAdapter(message.channel);
    const envelope = this.toOutboundEnvelope(message);
    try {
      return await adapter.send(envelope, message.options);
    } catch (err) {
      return {
        status: "failed",
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  }

  /** Gateway entry point: verify + parse + ingest a webhook request. */
  async handleWebhook(channel: string, req: WebhookRequest): Promise<WebhookResult> {
    const adapter = this.getAdapter(channel);
    if (!adapter.verifyWebhook(req)) {
      return { status: 401, body: "invalid signature" };
    }
    let messages: PrismMessage[];
    try {
      messages = adapter.parseWebhook(req);
    } catch (err) {
      this.logger.error("webhook parse failed", { channel, err: String(err) });
      return { status: 400, body: "parse failed" };
    }
    void this.ingest(messages);
    return { status: 200, body: "ok" };
  }

  /** Ingest already-normalized inbound messages (dedupe then dispatch). */
  async ingest(messages: PrismMessage[]): Promise<void> {
    for (const message of messages) {
      const key = `${message.channel}:${message.id}`;
      const first = await this.dedupe.claim(key);
      if (!first) {
        this.logger.debug("duplicate inbound dropped", { key });
        continue;
      }
      for (const handler of this.handlers) {
        try {
          await handler(message);
        } catch (err) {
          this.logger.error("inbound handler failed", {
            channel: message.channel,
            id: message.id,
            err: String(err),
          });
        }
      }
      this.emit("message", message);
    }
  }

  private async processJob(job: OutboxJob): Promise<void> {
    const adapter = this.adapters.get(job.channel);
    if (!adapter) {
      this.logger.error("job for unknown channel", { channel: job.channel, jobId: job.id });
      return;
    }
    const attempt = job.attempt + 1;
    try {
      const envelope = this.toOutboundEnvelope(job.message);
      const result = await adapter.send(envelope, job.message.options);
      if (result.status === "sent") {
        this.logger.info("message delivered", {
          channel: job.channel,
          jobId: job.id,
          platformMessageId: result.platformMessageId,
          attempt,
        });
        this.emit("delivered", { job, result });
        return;
      }
      throw result.error ?? new PrismError("SEND_FAILED", "adapter reported failure");
    } catch (err) {
      const retryable =
        err instanceof PrismError ? err.retryable : !(err instanceof Error) || true;
      if (attempt >= this.maxAttempts || !retryable) {
        this.logger.error("message dead-lettered", {
          channel: job.channel,
          jobId: job.id,
          attempt,
          err: String(err),
        });
        this.onDeadLetter?.({ ...job, lastError: String(err) });
        this.emit("dead_letter", { job, error: err } satisfies DeadLetterEntry);
        return;
      }
      const delay = this.baseBackoffMs * 2 ** (attempt - 1);
      this.logger.warn("delivery failed, scheduling retry", {
        channel: job.channel,
        jobId: job.id,
        attempt,
        delayMs: delay,
        err: String(err),
      });
      const retried: OutboxJob = { ...job, attempt, lastError: String(err) };
      if (this.memoryQueue) {
        this.memoryQueue.scheduleRetry(retried, delay);
      } else {
        await this.queue.enqueue(retried);
      }
    }
  }

  private toOutboundEnvelope(message: OutboundMessage): PrismMessage {
    return {
      id: newId(),
      channel: message.channel,
      direction: "outbound",
      from: "", // filled by adapter from its own identity config
      to: message.to,
      content: message.content,
      timestamp: Date.now(),
      metadata: message.metadata ?? {},
    };
  }

  private getAdapter(channel: string): ChannelAdapter {
    const adapter = this.adapters.get(channel);
    if (!adapter) throw new ChannelNotFoundError(channel);
    return adapter;
  }
}
