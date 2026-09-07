/**
 * Prism unified message model.
 *
 * Every platform-specific payload (Telegram update, WhatsApp message,
 * LINE event, email, ...) is normalized into {@link PrismMessage} so that
 * business code never touches platform formats.
 */

/** Logical channel identifier, e.g. `telegram` | `whatsapp` | `line` | `email`. */
export type ChannelId = string;

export type MessageDirection = "inbound" | "outbound";

/**
 * Structured content block. Adapters translate blocks to/from native
 * platform formats; unsupported blocks degrade gracefully (see adapter
 * `capabilities`).
 */
export type ContentBlock =
  | TextBlock
  | ImageBlock
  | AudioBlock
  | VideoBlock
  | FileBlock
  | LocationBlock
  | StickerBlock
  | ContactBlock
  | TemplateBlock;

export interface TextBlock {
  type: "text";
  text: string;
  /** Optional lightweight formatting hints. Adapters map or strip them. */
  format?: "plain" | "markdown" | "html";
}

export interface ImageBlock {
  type: "image";
  /** Remote URL or adapter-accepted reference (e.g. file_id). */
  url: string;
  caption?: string;
}

export interface AudioBlock {
  type: "audio";
  url: string;
  durationSec?: number;
}

export interface VideoBlock {
  type: "video";
  url: string;
  caption?: string;
  durationSec?: number;
}

export interface FileBlock {
  type: "file";
  url: string;
  filename?: string;
  mimetype?: string;
}

export interface LocationBlock {
  type: "location";
  latitude: number;
  longitude: number;
  title?: string;
  address?: string;
}

export interface StickerBlock {
  type: "sticker";
  /** Platform sticker id or emoji, depending on channel. */
  id: string;
}

export interface ContactBlock {
  type: "contact";
  name?: string;
  phone?: string;
  email?: string;
  userId?: string;
}

/**
 * Structured template payload (buttons / quick replies / cards).
 * Adapters render to the closest native interactive construct.
 */
export interface TemplateBlock {
  type: "template";
  /** Template name or key, adapter specific. */
  template: string;
  params: Record<string, string>;
}

/** The normalized message envelope. */
export interface PrismMessage {
  /** Globally unique message id (generated for outbound, derived for inbound). */
  id: string;
  channel: ChannelId;
  direction: MessageDirection;
  /**
   * Sender address in platform terms: Telegram chat id, WhatsApp phone
   * number (JID), LINE user id, email address, ...
   */
  from: string;
  /** Recipient address in platform terms. */
  to: string;
  content: ContentBlock[];
  /** Unix epoch milliseconds. */
  timestamp: number;
  /** Platform-native payload, kept for escape hatches. */
  raw?: unknown;
  /** Arbitrary adapter/business metadata. */
  metadata: Record<string, unknown>;
}

/** Message requested by business code; enriched by the hub before delivery. */
export interface OutboundMessage {
  channel: ChannelId;
  to: string;
  content: ContentBlock[];
  /** Business idempotency key; also used to dedupe retries. */
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
  /** Adapter-level options pass-through (e.g. Telegram parse_mode). */
  options?: Record<string, unknown>;
}

export type DeliveryStatus =
  | "queued"
  | "sent"
  | "failed"
  | "retry_scheduled"
  | "dead_letter";

export interface DeliveryResult {
  status: DeliveryStatus;
  /** Platform message id once accepted. */
  platformMessageId?: string;
  error?: Error;
}

/** Webhook request abstraction so core stays HTTP-framework agnostic. */
export interface WebhookRequest {
  /** Raw headers, lowercase keys. */
  headers: Record<string, string>;
  /** Raw body as text (needed for signature verification). */
  rawBody: string;
  /** Parsed JSON body when applicable. */
  body?: unknown;
  /** Query params. */
  query?: Record<string, string>;
}

export interface WebhookResult {
  /** HTTP status the gateway should respond with. */
  status: number;
  body: string;
}
