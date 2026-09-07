import {
  ConfigurationError,
  type AdapterCapabilities,
  type AdapterContext,
  type ChannelAdapter,
  type ContentBlock,
  type DeliveryResult,
  type PrismMessage,
  type WebhookRequest,
  deterministicId,
  newId,
} from "@prism/core";
import { TelegramApiClient, type TgMessage, type TgUpdate } from "./telegram-api.js";

export interface TelegramAdapterOptions {
  botToken: string;
  /** Override Bot API base (self-hosted bot api server, tests). */
  apiBase?: string;
  /**
   * "polling" (default, dev friendly) or "webhook".
   * For webhook mode set `webhookUrl` and `secretToken`.
   */
  mode?: "polling" | "webhook";
  /** Public URL registered at Telegram for webhook mode. */
  webhookUrl?: string;
  /** X-Telegram-Bot-Api-Secret-Token shared secret for webhook mode. */
  secretToken?: string;
  /** Seconds between polling restarts after errors. */
  pollIntervalSec?: number;
}

const TG_FILE_URL = "https://api.telegram.org/file";

/**
 * Telegram Bot API adapter.
 *
 * Inbound: normalize `message` / `edited_message` updates into PrismMessages.
 * Outbound: translate content blocks to sendMessage/sendPhoto/... calls.
 */
export class TelegramAdapter implements ChannelAdapter {
  readonly channel = "telegram";
  readonly displayName = "Telegram";
  readonly requiredConfigKeys = ["botToken"] as const;

  private readonly opts: TelegramAdapterOptions;
  private client!: TelegramApiClient;
  private ctx: AdapterContext | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private polling = false;
  private stopped = true;
  private offset = 0;

  constructor(opts: TelegramAdapterOptions) {
    if (!opts.botToken) throw new ConfigurationError("Telegram adapter requires botToken.");
    this.opts = opts;
  }

  capabilities(): AdapterCapabilities {
    return {
      sendBlocks: ["text", "image", "audio", "video", "file", "location", "sticker", "contact", "template"],
      receiveBlocks: ["text", "image", "audio", "video", "file", "location", "sticker", "contact"],
      features: { webhook: true, receipts: false, interactive: true },
    };
  }

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    this.stopped = false;
    this.client = new TelegramApiClient({
      token: this.opts.botToken,
      apiBase: this.opts.apiBase,
    });
    const mode = this.opts.mode ?? "polling";
    if (mode === "webhook") {
      if (!this.opts.webhookUrl || !this.opts.secretToken) {
        throw new ConfigurationError(
          "webhook mode requires webhookUrl and secretToken."
        );
      }
      await this.client.call("setWebhook", {
        url: this.opts.webhookUrl,
        secret_token: this.opts.secretToken,
        allowed_updates: ["message", "edited_message"],
      });
      return;
    }
    // Delete possibly stale webhook, then start polling.
    await this.client.call("deleteWebhook", { drop_pending_updates: false }).catch(() => undefined);
    this.pollLoop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.client?.stopPolling();
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  async send(message: PrismMessage, options?: Record<string, unknown>): Promise<DeliveryResult> {
    const chatId = message.to;
    const blocks = message.content;
    if (blocks.length === 0) {
      return { status: "failed", error: new Error("empty content") };
    }
    // Send all blocks; the first send uses sendMessage-equivalent call,
    // subsequent blocks are appended as separate platform messages.
    let platformMessageId: string | undefined;
    for (const block of blocks) {
      const mid = await this.sendBlock(chatId, block, options);
      platformMessageId ??= mid;
    }
    return { status: "sent", platformMessageId };
  }

  private async sendBlock(
    chatId: string,
    block: ContentBlock,
    options?: Record<string, unknown>
  ): Promise<string | undefined> {
    const parseMode =
      (options?.parseMode as string | undefined) ??
      (blocksToParseMode(block) ?? undefined);
    const reply = options?.replyToMessageId as number | undefined;
    switch (block.type) {
      case "text": {
        const r = await this.client.call<{ message_id: number }>("sendMessage", {
          chat_id: chatId,
          text: block.text,
          ...(parseMode ? { parse_mode: parseMode } : {}),
          ...(reply ? { reply_to_message_id: reply } : {}),
        });
        return String(r.message_id);
      }
      case "image": {
        const r = await this.client.call<{ message_id: number }>("sendPhoto", {
          chat_id: chatId,
          photo: block.url,
          ...(block.caption ? { caption: block.caption } : {}),
          ...(parseMode ? { parse_mode: parseMode } : {}),
        });
        return String(r.message_id);
      }
      case "audio": {
        const r = await this.client.call<{ message_id: number }>("sendAudio", {
          chat_id: chatId,
          audio: block.url,
          ...(block.durationSec ? { duration: block.durationSec } : {}),
        });
        return String(r.message_id);
      }
      case "video": {
        const r = await this.client.call<{ message_id: number }>("sendVideo", {
          chat_id: chatId,
          video: block.url,
          ...(block.caption ? { caption: block.caption } : {}),
        });
        return String(r.message_id);
      }
      case "file": {
        const r = await this.client.call<{ message_id: number }>("sendDocument", {
          chat_id: chatId,
          document: block.url,
          ...(block.filename ? { visible_file_name: block.filename } : {}),
        });
        return String(r.message_id);
      }
      case "location": {
        const r = await this.client.call<{ message_id: number }>("sendLocation", {
          chat_id: chatId,
          latitude: block.latitude,
          longitude: block.longitude,
        });
        return String(r.message_id);
      }
      case "sticker": {
        const r = await this.client.call<{ message_id: number }>("sendSticker", {
          chat_id: chatId,
          sticker: block.id,
        });
        return String(r.message_id);
      }
      case "contact": {
        const r = await this.client.call<{ message_id: number }>("sendContact", {
          chat_id: chatId,
          ...(block.phone ? { phone_number: block.phone } : {}),
          ...(block.name ? { first_name: block.name } : {}),
        });
        return String(r.message_id);
      }
      case "template": {
        // No native template construct; render params as text fallback.
        const rendered = `[${block.template}] ${Object.entries(block.params)
          .map(([k, v]) => `${k}=${v}`)
          .join(" ")}`;
        const r = await this.client.call<{ message_id: number }>("sendMessage", {
          chat_id: chatId,
          text: rendered,
        });
        return String(r.message_id);
      }
      default:
        return undefined;
    }
  }

  verifyWebhook(req: WebhookRequest): boolean {
    if (this.opts.mode !== "webhook") return false;
    const expected = this.opts.secretToken ?? "";
    const provided = req.headers["x-telegram-bot-api-secret-token"] ?? "";
    return timingSafeEqualStr(expected, provided);
  }

  parseWebhook(req: WebhookRequest): PrismMessage[] {
    const update = req.body as TgUpdate | undefined;
    if (!update || typeof update !== "object") return [];
    return updateToMessages(update);
  }

  private pollLoop(): void {
    if (this.stopped || !this.ctx) return;
    const ctx = this.ctx;
    this.polling = true;
    void (async () => {
      while (!this.stopped) {
        const updates = await this.client.getUpdates(this.offset, 25);
        if (this.stopped) break;
        for (const u of updates) {
          this.offset = u.update_id + 1;
          const messages = updateToMessages(u);
          if (messages.length > 0) ctx.dispatchInbound(messages);
        }
        if (updates.length === 0 && this.opts.pollIntervalSec) {
          await sleep(this.opts.pollIntervalSec * 1000);
        }
      }
    })().finally(() => {
      this.polling = false;
      if (!this.stopped) {
        // Restart after unexpected exit (defensive).
        this.pollTimer = setTimeout(() => this.pollLoop(), 5000);
      }
    });
  }
}

// ---- conversion helpers ---------------------------------------------------

export function updateToMessages(update: TgUpdate): PrismMessage[] {
  const tg = update.message ?? update.edited_message;
  if (!tg) return [];
  const msg = tgMessageToPrism(tg, update.update_id);
  return msg ? [msg] : [];
}

export function tgMessageToPrism(m: TgMessage, updateId: number): PrismMessage | null {
  if (!m.chat) return null;
  const content: ContentBlock[] = [];
  if (m.text) content.push({ type: "text", text: m.text });
  if (m.photo && m.photo.length > 0) {
    const best = m.photo[m.photo.length - 1];
    if (best) content.push({ type: "image", url: best.file_id, caption: m.caption });
  }
  if (m.audio) content.push({ type: "audio", url: m.audio.file_id, durationSec: m.audio.duration });
  if (m.voice) content.push({ type: "audio", url: m.voice.file_id, durationSec: m.voice.duration });
  if (m.video) content.push({ type: "video", url: m.video.file_id, caption: m.caption });
  if (m.document)
    content.push({
      type: "file",
      url: m.document.file_id,
      filename: m.document.filename,
      mimetype: m.document.mime_type,
    });
  if (m.sticker) content.push({ type: "sticker", id: m.sticker.file_id });
  if (m.location)
    content.push({ type: "location", latitude: m.location.latitude, longitude: m.location.longitude });
  if (m.contact)
    content.push({
      type: "contact",
      phone: m.contact.phone_number,
      name: m.contact.first_name,
      userId: m.contact.user_id !== undefined ? String(m.contact.user_id) : undefined,
    });
  if (content.length === 0) return null;
  return {
    id: deterministicId("telegram", updateId),
    channel: "telegram",
    direction: "inbound",
    from: String(m.chat.id),
    to: m.from ? String(m.from.id) : "bot",
    content,
    timestamp: m.date * 1000,
    raw: m,
    metadata: {
      chatType: m.chat.type,
      chatTitle: m.chat.title ?? null,
      fromUsername: m.from?.username ?? null,
      tgMessageId: m.message_id,
    },
  };
}

function blocksToParseMode(block: ContentBlock): string | null {
  if (block.type !== "text") return null;
  return block.format === "markdown" ? "MarkdownV2" : block.format === "html" ? "HTML" : null;
}

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// keep file url helper referenced for future getFile download flows
void TG_FILE_URL;
