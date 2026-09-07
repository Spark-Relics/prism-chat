import { createHmac, timingSafeEqual } from "node:crypto";
import {
  ConfigurationError,
  PrismError,
  type AdapterCapabilities,
  type AdapterContext,
  type ChannelAdapter,
  type CredentialManager,
  type CredentialProvider,
  type DeliveryResult,
  type PrismMessage,
  type WebhookRequest,
  credentialManager,
  deterministicId,
} from "@prism/core";

export interface LineAdapterOptions {
  /**
   * Channel access token, or a credential provider for externally managed
   * login/refresh (e.g. OAuthCredentialProvider against
   * https://api.line.me/v2/oauth/accessToken).
   */
  channelAccessToken: string | CredentialProvider;
  channelSecret: string;
}

interface LineEvent {
  type?: string;
  replyToken?: string;
  timestamp?: number;
  source?: { type?: string; userId?: string; groupId?: string; roomId?: string };
  message?: {
    id?: string;
    type?: string;
    text?: string;
    title?: string;
    address?: string;
    latitude?: number;
    longitude?: number;
    fileName?: string;
    durationMs?: number;
  };
}

/**
 * LINE Messaging API adapter (skeleton).
 *
 * Implemented: webhook signature verification, inbound text/location/file
 * parsing, text/image reply via replyToken. TODO: rich menus, push groups.
 */
export class LineAdapter implements ChannelAdapter {
  readonly channel = "line";
  readonly displayName = "LINE";
  readonly requiredConfigKeys = ["channelAccessToken", "channelSecret"] as const;

  private readonly credentials: CredentialManager;
  private readonly opts: LineAdapterOptions;

  constructor(opts: LineAdapterOptions) {
    if (!opts.channelAccessToken || !opts.channelSecret) {
      throw new ConfigurationError("LINE adapter requires channelAccessToken and channelSecret.");
    }
    this.opts = opts;
    this.credentials = credentialManager(opts.channelAccessToken);
  }

  capabilities(): AdapterCapabilities {
    return {
      sendBlocks: ["text", "image", "video", "file", "location", "template"],
      receiveBlocks: ["text", "image", "audio", "video", "file", "location"],
      features: { webhook: true, receipts: false, interactive: true },
    };
  }

  async start(_ctx: AdapterContext): Promise<void> {}

  async stop(): Promise<void> {}

  async send(message: PrismMessage): Promise<DeliveryResult> {
    const blocks = message.content.map(toLineMessage).filter(Boolean) as LineSendMessage[];
    if (blocks.length === 0) return { status: "failed", error: new Error("empty content") };
    const doFetch = async (): Promise<Response> => {
      const token = await this.credentials.getBearerToken();
      return fetch("https://api.line.me/v2/bot/message/push", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ to: message.to, messages: blocks.slice(0, 5) }),
      });
    };
    let res = await doFetch();
    // Stale token? Invalidate once and retry with a fresh login.
    if (res.status === 401 || res.status === 403) {
      this.credentials.invalidate();
      res = await doFetch();
    }
    if (!res.ok) {
      const retryable = res.status >= 500 || res.status === 429;
      throw new PrismError(
        retryable ? "RATE_LIMITED" : "SEND_FAILED",
        `LINE API ${res.status}: ${await res.text()}`,
        { retryable }
      );
    }
    return { status: "sent" };
  }

  verifyWebhook(req: WebhookRequest): boolean {
    const signature = req.headers["x-line-signature"];
    if (!signature) return false;
    const expected = createHmac("sha256", this.opts.channelSecret)
      .update(req.rawBody)
      .digest("base64");
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  parseWebhook(req: WebhookRequest): PrismMessage[] {
    const body = req.body as { events?: LineEvent[] };
    const out: PrismMessage[] = [];
    for (const ev of body.events ?? []) {
      if (ev.type === "message" && ev.message && ev.source?.userId) {
        out.push(lineEventToPrism(ev));
      }
    }
    return out;
  }
}

function lineEventToPrism(ev: LineEvent): PrismMessage {
  const m = ev.message!;
  const content: PrismMessage["content"] = [];
  switch (m.type) {
    case "text":
      content.push({ type: "text", text: m.text ?? "" });
      break;
    case "image":
      content.push({ type: "image", url: m.id ?? "" }); // message id → content API
      break;
    case "audio":
      content.push({ type: "audio", url: m.id ?? "", durationSec: m.durationMs ? m.durationMs / 1000 : undefined });
      break;
    case "video":
      content.push({ type: "video", url: m.id ?? "" });
      break;
    case "file":
      content.push({ type: "file", url: m.id ?? "", filename: m.fileName });
      break;
    case "location":
      if (m.latitude !== undefined && m.longitude !== undefined) {
        content.push({
          type: "location",
          latitude: m.latitude,
          longitude: m.longitude,
          title: m.title,
          address: m.address,
        });
      }
      break;
    default:
      content.push({ type: "text", text: `[unsupported: ${m.type ?? "unknown"}]` });
  }
  return {
    id: deterministicId("line", ev.message?.id ?? "", ev.timestamp ?? 0),
    channel: "line",
    direction: "inbound",
    from: ev.source!.userId!,
    to: ev.source?.groupId ?? ev.source?.roomId ?? "bot",
    content,
    timestamp: ev.timestamp ?? Date.now(),
    raw: ev,
    metadata: {
      ...(ev.replyToken ? { replyToken: ev.replyToken } : {}),
      sourceType: ev.source?.type,
    },
  };
}

type LineSendMessage = Record<string, unknown>;

function toLineMessage(block: PrismMessage["content"][number]): LineSendMessage | null {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "image":
      return { type: "image", originalContentUrl: block.url, previewImageUrl: block.url };
    case "video":
      return { type: "video", originalContentUrl: block.url, previewImageUrl: block.url };
    case "audio":
      return {
        type: "audio",
        originalContentUrl: block.url,
        duration: block.durationSec ? Math.round(block.durationSec * 1000) : 60000,
      };
    case "file":
      return { type: "file", url: block.url, fileName: block.filename ?? "file" };
    case "location":
      return {
        type: "location",
        title: block.title ?? "Location",
        address: block.address ?? "",
        latitude: block.latitude,
        longitude: block.longitude,
      };
    case "template":
      return { type: "text", text: `[template ${block.template}]` };
    default:
      return null;
  }
}
