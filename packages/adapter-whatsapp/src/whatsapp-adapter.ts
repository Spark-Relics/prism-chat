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
import { createHmac, timingSafeEqual } from "node:crypto";

export interface WhatsAppAdapterOptions {
  /** Meta app credentials (Cloud API). */
  phoneNumberId: string;
  /**
   * System-user access token, or a credential provider for externally
   * managed login/refresh (e.g. OAuthCredentialProvider against
   * https://graph.facebook.com/oauth/access_token).
   */
  accessToken: string | CredentialProvider;
  /** v21.0 by default. */
  apiVersion?: string;
  /**
   * Hub verification: GET with hub.mode=subscribe & hub.verify_token.
   */
  verifyToken?: string;
  /** Optional GET-app-signature verifier (X-Hub-Signature-256). */
  appSecret?: string;
}

/**
 * WhatsApp Cloud API adapter (skeleton).
 *
 * Implemented: webhook verification (meta subscribe flow), inbound message
 * parsing, text sending. TODO: media blocks, template messages.
 */
export class WhatsAppAdapter implements ChannelAdapter {
  readonly channel = "whatsapp";
  readonly displayName = "WhatsApp";
  readonly requiredConfigKeys = ["phoneNumberId", "accessToken"] as const;

  private readonly opts: WhatsAppAdapterOptions;
  private readonly apiBase: string;
  private readonly credentials: CredentialManager;

  constructor(opts: WhatsAppAdapterOptions) {
    if (!opts.phoneNumberId || !opts.accessToken) {
      throw new ConfigurationError("WhatsApp adapter requires phoneNumberId and accessToken.");
    }
    this.opts = opts;
    this.apiBase = `https://graph.facebook.com/${opts.apiVersion ?? "v21.0"}`;
    this.credentials = credentialManager(opts.accessToken);
  }

  capabilities(): AdapterCapabilities {
    return {
      sendBlocks: ["text", "image", "video", "file", "audio", "template"],
      receiveBlocks: ["text", "image", "audio", "video", "file", "location", "contact"],
      features: { webhook: true, receipts: true, interactive: true },
    };
  }

  async start(_ctx: AdapterContext): Promise<void> {
    // Cloud API is stateless; nothing to start.
  }

  async stop(): Promise<void> {}

  async send(message: PrismMessage): Promise<DeliveryResult> {
    const first = message.content[0];
    if (!first) return { status: "failed", error: new Error("empty content") };
    const payload = this.blockToPayload(message.to, first);
    const doFetch = async (): Promise<Response> => {
      const token = await this.credentials.getBearerToken();
      return fetch(`${this.apiBase}/${this.opts.phoneNumberId}/messages`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
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
        `WhatsApp API ${res.status}: ${await res.text()}`,
        { retryable }
      );
    }
    const json = (await res.json()) as {
      messages?: Array<{ id: string }>;
    };
    return { status: "sent", platformMessageId: json.messages?.[0]?.id };
  }

  private blockToPayload(
    to: string,
    block: PrismMessage["content"][number]
  ): Record<string, unknown> {
    switch (block.type) {
      case "text":
        return { messaging_product: "whatsapp", to, type: "text", text: { body: block.text } };
      case "image":
        return { messaging_product: "whatsapp", to, type: "image", image: { link: block.url } };
      case "video":
        return { messaging_product: "whatsapp", to, type: "video", video: { link: block.url } };
      case "audio":
        return { messaging_product: "whatsapp", to, type: "audio", audio: { link: block.url } };
      case "file":
        return {
          messaging_product: "whatsapp",
          to,
          type: "document",
          document: { link: block.url, ...(block.filename ? { filename: block.filename } : {}) },
        };
      case "template":
        return {
          messaging_product: "whatsapp",
          to,
          type: "template",
          template: {
            name: block.template,
            language: { code: "en_US" },
            components: [
              {
                type: "body",
                parameters: Object.values(block.params).map((v) => ({ type: "text", text: v })),
              },
            ],
          },
        };
      default:
        throw new PrismError("UNSUPPORTED_BLOCK", `WhatsApp cannot send block "${block.type}" yet.`);
    }
  }

  verifyWebhook(req: WebhookRequest): boolean {
    // GET subscription handshake: handled by the gateway before parse; here we
    // verify POST signature if appSecret configured.
    if (!this.opts.appSecret) return true; // not configured: accept (dev mode)
    // X-Hub-Signature-256: sha256=<hex>
    const header = req.headers["x-hub-signature-256"];
    if (!header) return false;
    const expected =
      "sha256=" +
      createHmac("sha256", this.opts.appSecret).update(req.rawBody, "utf8").digest("hex");
    return safeEqualHex(expected, header);
  }

  parseWebhook(req: WebhookRequest): PrismMessage[] {
    const body = req.body as {
      entry?: Array<{
        changes?: Array<{
          value?: {
            messages?: Array<Record<string, unknown>>;
            metadata?: { phone_number_id?: string };
          };
        }>;
      }>;
    };
    const out: PrismMessage[] = [];
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        if (!value?.messages) continue;
        for (const m of value.messages) {
          const parsed = parseWaMessage(m);
          if (parsed) out.push(parsed);
        }
      }
    }
    return out;
  }
}

function parseWaMessage(m: Record<string, unknown>): PrismMessage | null {
  const from = str(m.from);
  const id = str(m.id);
  const timestamp = num(m.timestamp);
  if (!from || !id) return null;
  const type = str(m.type) ?? "";
  const content: PrismMessage["content"] = [];
  switch (type) {
    case "text":
      content.push({ type: "text", text: str((m.text as Record<string, unknown>)?.body) ?? "" });
      break;
    case "image":
    case "video":
    case "audio":
      content.push({
        type,
        url: str((m[type] as Record<string, unknown> | undefined)?.id) ?? "",
      } as PrismMessage["content"][number]);
      break;
    case "document": {
      const doc = m.document as Record<string, unknown> | undefined;
      content.push({
        type: "file",
        url: str(doc?.id) ?? "",
        filename: str(doc?.filename),
      });
      break;
    }
    case "location": {
      const loc = m.location as { latitude?: number; longitude?: number } | undefined;
      if (loc?.latitude !== undefined && loc.longitude !== undefined) {
        content.push({ type: "location", latitude: loc.latitude, longitude: loc.longitude });
      }
      break;
    }
    default:
      return null;
  }
  if (content.length === 0) return null;
  return {
    id: deterministicId("whatsapp", id),
    channel: "whatsapp",
    direction: "inbound",
    from,
    to: str(m.metadata ?? "") || "bot",
    content,
    timestamp: timestamp ? timestamp * 1000 : Date.now(),
    raw: m,
    metadata: { waId: id },
  };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Constant-time comparison of two "sha256=<hex>" signature strings. */
function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined;
}
