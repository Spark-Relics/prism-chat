import type {
  ChannelId,
  ContentBlock,
  DeliveryResult,
  OutboundMessage,
  PrismMessage,
  WebhookRequest,
  WebhookResult,
} from "./types.js";
import type { Logger } from "./logger.js";

/**
 * The one contract every channel adapter must implement.
 * Adapters are pure protocol translators: no storage, no business logic.
 */
export interface ChannelAdapter {
  /** Unique channel id this adapter handles, e.g. "telegram". */
  readonly channel: ChannelId;
  /** Human-readable name. */
  readonly displayName: string;
  /** Config schema keys required (documentation helper). */
  readonly requiredConfigKeys: readonly string[];

  /** Declare which content blocks this channel can send/receive. */
  capabilities(): AdapterCapabilities;

  /** Long-lived loops (polling etc.) start here. Resolve when ready. */
  start(ctx: AdapterContext): Promise<void>;
  /** Stop loops; called on shutdown. Must be idempotent. */
  stop(): Promise<void>;

  /** Deliver an outbound message. Throw PrismError on failure. */
  send(message: PrismMessage, options?: Record<string, unknown>): Promise<DeliveryResult>;

  /** Verify webhook authenticity (signature, token). Return false to reject. */
  verifyWebhook(req: WebhookRequest): boolean;
  /** Parse a verified webhook into zero or more inbound PrismMessages. */
  parseWebhook(req: WebhookRequest): PrismMessage[];
}

export interface AdapterCapabilities {
  /** Blocks the channel can send. */
  sendBlocks: readonly ContentBlock["type"][];
  /** Blocks the channel can produce on inbound messages. */
  receiveBlocks: readonly ContentBlock["type"][];
  /** Channel features. */
  features: {
    webhook: boolean;
    /** Channel supports delivery/read receipts. */
    receipts: boolean;
    /** Channel supports interactive replies (buttons, quick replies). */
    interactive: boolean;
  };
}

/** Services the hub injects into adapters at start(). */
export interface AdapterContext {
  logger: Logger;
  /** Called by polling adapters to feed inbound messages into the pipeline. */
  dispatchInbound(messages: PrismMessage[]): void;
}
