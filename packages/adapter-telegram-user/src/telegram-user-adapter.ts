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
} from "@prism/core";

/**
 * Minimal structural types for the dynamically imported GramJS client.
 * Keeping them local avoids a hard compile-time dependency on `telegram`;
 * the package is an optional peerDependency.
 */
interface TgEntityLike {
  className?: string;
  messageId?: number;
  document?: { mimeType?: string; attributes?: { className?: string; fileName?: string }[] };
  photo?: unknown;
  geo?: { lat?: number; long?: number };
  media?: unknown;
  message?: string;
}

interface TgUpdateLike {
  className?: string;
  message?: TgEntityLike;
}

interface GramJsClientLike {
  start(params: {
    phoneNumber?: string;
    password?: string;
    phoneCode?: () => Promise<string>;
    onError?: (err: unknown) => void;
  }): Promise<void>;
  connect(): Promise<boolean>;
  disconnect(): Promise<void>;
  getMe(): Promise<{ id?: { toString(): string }; username?: string }>;
  sendMessage(entity: string, message: string, params?: Record<string, unknown>): Promise<{ id?: { toString(): string } }>;
  sendFile(entity: string, params?: Record<string, unknown>): Promise<{ id?: { toString(): string } }>;
  addEventHandler(handler: (update: TgUpdateLike) => void): void;
  session: { save?(): string };
}

export interface TelegramUserAdapterOptions {
  /**
   * Telegram api_id + api_hash from https://my.telegram.org.
   */
  apiId: number;
  apiHash: string;
  /**
   * StringSession previously obtained from a completed login.
   * When absent, the adapter requires `phoneNumber` and performs an
   * interactive login (needs code callback from your system).
   */
  session?: string;
  /** E.164 phone number for first-time interactive login. */
  phoneNumber?: string;
  /**
   * Supplies the login verification code (and 2FA password) during the
   * first login. Wire this to your SMS inbox / user prompt / secret store.
   */
  codeProvider?: () => Promise<string>;
  /** 2FA password (when the account has it). */
  password?: string;
  /**
   * Called after a successful login with the serialized StringSession —
   * persist it and pass it back via `session` on next start to avoid
   * re-login. Recommended: always implement this.
   */
  onSessionSaved?: (session: string) => void | Promise<void>;
  /** Where to persist/resume sessions internally (informational). */
  sessionName?: string;
}

/**
 * Telegram personal-account (userbot) adapter over MTProto/GramJS.
 *
 * ⚠️ Using personal accounts programmatically violates Telegram's ToS
 * and can lead to account termination. Use at your own risk; prefer
 * the Bot API (`@prism/adapter-telegram`) for production workloads.
 *
 * Inbound: NewMessage updates → PrismMessage.
 * Outbound: content blocks → sendMessage / sendFile.
 */
export class TelegramUserAdapter implements ChannelAdapter {
  readonly channel = "telegram-user";
  readonly displayName = "Telegram (personal)";
  readonly requiredConfigKeys = ["apiId", "apiHash"] as const;

  private readonly opts: TelegramUserAdapterOptions;
  private client: GramJsClientLike | null = null;
  private ctx: AdapterContext | null = null;
  private stopped = true;  private readonly handler = undefined;

  constructor(opts: TelegramUserAdapterOptions) {
    if (!opts.apiId || !opts.apiHash) {
      throw new ConfigurationError("Telegram user adapter requires apiId and apiHash.");
    }
    if (!opts.session && !opts.phoneNumber) {
      throw new ConfigurationError(
        "Provide a saved `session` (StringSession) or `phoneNumber` for first-time login."
      );
    }
    this.opts = opts;
  }

  capabilities(): AdapterCapabilities {
    return {
      sendBlocks: ["text", "image", "video", "audio", "file", "location", "sticker", "contact"],
      receiveBlocks: ["text", "image", "video", "audio", "file", "location", "sticker", "contact"],
      features: { webhook: false, receipts: false, interactive: false },
    };
  }

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    this.stopped = false;

    const telegram = await import("telegram").catch(() => null) as typeof import("telegram") | null;
    if (!telegram) {
      throw new ConfigurationError(
        "GramJS (`telegram` npm package) is not installed. Run `pnpm add telegram input` to use the Telegram personal-account adapter."
      );
    }
    // `telegram/sessions` (ESM subpath) — load via dynamic import with .js suffix
    const sessionsMod = (await import("telegram/sessions/index.js").catch(() => null)) as {
      StringSession: new (s?: string) => { save(): string };
    } | null;
    const StringSession = sessionsMod?.StringSession;
    if (!StringSession) {
      throw new ConfigurationError("Cannot load `telegram/sessions` (GramJS). Is the `telegram` package intact?");
    }

    const client = new telegram.TelegramClient(
      new StringSession(this.opts.session) as unknown as ConstructorParameters<
        typeof telegram.TelegramClient
      >[0],
      this.opts.apiId,
      this.opts.apiHash,
      { connectionRetries: 5 }
    ) as unknown as GramJsClientLike;

    if (this.opts.session) {
      await client.connect();
    } else {
      await client.start({
        phoneNumber: this.opts.phoneNumber,
        password: this.opts.password,
        phoneCode: this.opts.codeProvider
          ? async () => await this.opts.codeProvider!()
          : async () => {
              // Fall back to interactive console input when no provider given.
              const input = (await import("input").catch(() => null)) as unknown as { text: (q: string) => Promise<string> } | null;
              if (!input) throw new ConfigurationError(
                "No `codeProvider` configured and `input` package unavailable for interactive login."
              );
              return input.text("Telegram login code: ");
            },
        onError: (err) => ctx.logger.error("telegram-user login error", { err: String(err) }),
      });
    }

    const me = await client.getMe();
    ctx.logger.info("telegram-user adapter started", {
      user: me?.username ?? me?.id?.toString(),
    });

    // Persist the session for next boots.
    const saved = client.session.save?.();
    if (saved && saved !== this.opts.session) {
      await this.opts.onSessionSaved?.(saved);
    }

    client.addEventHandler((update) => this.onUpdate(update));
    this.client = client;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.client?.disconnect();
    this.client = null;
  }

  async send(message: PrismMessage, options?: Record<string, unknown>): Promise<DeliveryResult> {
    const client = this.client;
    if (!client) return { status: "failed", error: new Error("adapter not started") };
    if (message.content.length === 0) {
      return { status: "failed", error: new Error("empty content") };
    }
    let platformMessageId: string | undefined;
    for (const block of message.content) {
      const mid = await this.sendBlock(client, message.to, block, options);
      platformMessageId ??= mid;
    }
    return { status: "sent", platformMessageId };
  }

  verifyWebhook(): boolean {
    // MTProto clients are long-lived connections, not webhooks.
    return false;
  }

  parseWebhook(): PrismMessage[] {
    return [];
  }

  // ---- internals ------------------------------------------------------------

  private async sendBlock(
    client: GramJsClientLike,
    to: string,
    block: ContentBlock,
    options?: Record<string, unknown>
  ): Promise<string | undefined> {
    switch (block.type) {
      case "text": {
        const r = await client.sendMessage(to, block.text, {
          ...(block.format === "markdown" ? { parseMode: "md" } : {}),
          ...(block.format === "html" ? { parseMode: "html" } : {}),
          ...(options?.replyToMessageId !== undefined
            ? { replyTo: options.replyToMessageId }
            : {}),
        });
        return r.id?.toString();
      }
      case "image":
      case "video":
      case "audio":
      case "file": {
        const sendFile = client.sendFile as unknown as (
          entity: string,
          params: Record<string, unknown>
        ) => Promise<{ id?: { toString(): string } }>;
        const r = await sendFile(to, {
          file: block.url,
          ...(block.type === "image" && "caption" in block && block.caption
            ? { caption: block.caption }
            : {}),
          ...(block.type === "video" && "caption" in block && block.caption
            ? { caption: block.caption }
            : {}),
          ...(block.type === "file" && "filename" in block && block.filename
            ? { fileName: block.filename }
            : {}),
          ...(block.type === "audio" && "durationSec" in block && block.durationSec
            ? { duration: block.durationSec }
            : {}),
          ...(block.type === "video" && "durationSec" in block && block.durationSec
            ? { duration: block.durationSec }
            : {}),
          voiceNote: block.type === "audio" ? false : undefined,
        });
        return r.id?.toString();
      }
      case "location": {
        const r = await client.sendMessage(to, `📍 ${block.title ?? "Location"}\n${block.latitude}, ${block.longitude}`, {});
        return r.id?.toString();
      }
      case "sticker": {
        const sendFile = client.sendFile as unknown as (
          entity: string,
          params: Record<string, unknown>
        ) => Promise<{ id?: { toString(): string } }>;
        const r = await sendFile(to, { file: block.id });
        return r.id?.toString();
      }
      case "contact": {
        const lines = [block.name, block.phone, block.email].filter(Boolean).join("\n");
        const r = await client.sendMessage(to, lines, {});
        return r.id?.toString();
      }
      case "template": {
        const r = await client.sendMessage(to, block.template, {});
        return r.id?.toString();
      }
      default: {
        const b = block as { text?: string };
        const r = await client.sendMessage(to, b.text ?? "", {});
        return r.id?.toString();
      }
    }
  }

  private onUpdate(update: TgUpdateLike): void {
    if (this.stopped || !this.ctx) return;
    if (update.className !== "UpdateNewMessage" && update.className !== "UpdateNewChannelMessage") return;
    const msg = update.message;
    if (!msg) return;

    const messages = this.tgEntityToPrism(msg);
    if (messages.length > 0 && this.ctx) {
      const dispatched: unknown = this.ctx.dispatchInbound(messages);
      Promise.resolve(dispatched).catch((err: unknown) => {
        this.ctx?.logger.error("telegram-user dispatch failed", { err: String(err) });
      });
    }
  }

  private tgEntityToPrism(msg: TgEntityLike): PrismMessage[] {
    const peerId = (msg as { peerId?: { userId?: { toString(): string }; channelId?: { toString(): string }; chatId?: { toString(): string } } }).peerId;
    const from =
      peerId?.userId?.toString() ??
      peerId?.channelId?.toString() ??
      peerId?.chatId?.toString() ??
      "unknown";

    const content: ContentBlock[] = [];
    if (msg.document) {
      const isSticker = msg.document.attributes?.some((a) => a.className === "DocumentAttributeSticker");
      const filename = msg.document.attributes?.find((a) => a.fileName)?.fileName;
      const isVoice = msg.document.mimeType?.startsWith("audio/");
      const isVideo = msg.document.mimeType?.startsWith("video/");
      const isImage = msg.document.mimeType?.startsWith("image/");
      if (isSticker) {
        content.push({ type: "sticker", id: filename ?? "sticker" });
      } else if (isImage) {
        content.push({ type: "image", url: "", caption: msg.message });
      } else if (isVideo) {
        content.push({ type: "video", url: "", caption: msg.message });
      } else if (isVoice) {
        content.push({ type: "audio", url: "" });
      } else {
        content.push({
          type: "file",
          url: "",
          filename: filename ?? "file",
          mimetype: msg.document.mimeType,
        });
      }
    } else if (msg.photo) {
      content.push({ type: "image", url: "", caption: msg.message });
    } else if (msg.geo) {
      content.push({ type: "location", latitude: msg.geo.lat ?? 0, longitude: msg.geo.long ?? 0 });
    } else if (msg.message) {
      content.push({ type: "text", text: msg.message });
    }

    if (content.length === 0) return [];

    const platformEventId = msg.messageId?.toString() ?? `${Date.now()}`;
    return [
      {
        id: deterministicId("telegram-user", platformEventId),
        channel: "telegram-user",
        direction: "inbound",
        from,
        to: "me",
        content,
        timestamp: Date.now(),
        raw: msg,
        metadata: { platformEventId },
      },
    ];
  }
}
