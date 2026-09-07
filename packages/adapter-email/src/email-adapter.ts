import nodemailer, { type Transporter } from "nodemailer";
import {
  ConfigurationError,
  PrismError,
  type AdapterCapabilities,
  type AdapterContext,
  type ChannelAdapter,
  type ContentBlock,
  type CredentialProvider,
  type DeliveryResult,
  type PrismMessage,
  type WebhookRequest,
  deterministicId,
} from "@prism/core";

export interface EmailAdapterOptions {
  /** SMTP transport config for outbound mail. */
  smtp?: {
    host: string;
    port?: number;
    secure?: boolean;
    /** Plain SMTP login. */
    auth?: { user: string; pass: string };
    /**
     * OAuth2 login (e.g. Gmail): the provider supplies the access token,
     * so external systems can plug in their own Google/Microsoft login.
     * Takes precedence over `auth`.
     */
    oauth2?: { user: string; provider: CredentialProvider };
  };
  /** Verified sender address, e.g. "bot@example.com". */
  fromAddress: string;
  fromName?: string;
  /**
   * Inbound provider whose webhook payload shape we parse:
   * "sendgrid" | "postmark" | "mailgun" | "generic".
   */
  inboundProvider?: "sendgrid" | "postmark" | "mailgun" | "generic";
  /** Verification hook; default accepts everything (implement signature check!).). */
  verify?: (req: WebhookRequest) => boolean;
}

/**
 * Email adapter.
 *
 * Outbound: SMTP via nodemailer; text blocks become the body, images/files
 * become attachments, html-format text is used as the html part.
 *
 * Inbound: parses provider webhook payloads into PrismMessages. Pair with
 * SendGrid Inbound Parse / Postmark inbound / Mailgun routes.
 */
export class EmailAdapter implements ChannelAdapter {
  readonly channel = "email";
  readonly displayName = "Email";
  readonly requiredConfigKeys = ["fromAddress"] as const;

  private readonly opts: EmailAdapterOptions;
  private transporter: Transporter | null = null;

  constructor(opts: EmailAdapterOptions) {
    if (!opts.fromAddress) throw new ConfigurationError("Email adapter requires fromAddress.");
    if (!opts.smtp) {
      // allowed for receive-only deployments
    }
    this.opts = opts;
  }

  capabilities(): AdapterCapabilities {
    return {
      sendBlocks: ["text", "image", "file", "template"],
      receiveBlocks: ["text", "file", "image"],
      features: { webhook: true, receipts: false, interactive: false },
    };
  }

  async start(_ctx: AdapterContext): Promise<void> {
    if (this.opts.smtp) {
      const { oauth2, auth, ...rest } = this.opts.smtp;
      if (oauth2) {
        // Fresh OAuth2 token per send; nodemailer reads it via the pool.
        this.transporter = nodemailer.createTransport({
          ...rest,
          pool: true,
          auth: {
            type: "OAuth2",
            user: oauth2.user,
            async accessToken() {
              return oauth2.provider.get().then((c) => {
                if (!c.accessToken) throw new Error("oauth2 credential provider returned no accessToken");
                return c.accessToken;
              });
            },
          },
        });
      } else {
        this.transporter = nodemailer.createTransport({ ...rest, auth });
      }
    }
  }

  async stop(): Promise<void> {
    this.transporter?.close();
    this.transporter = null;
  }

  async send(message: PrismMessage): Promise<DeliveryResult> {
    if (!this.transporter) {
      throw new PrismError("CONFIG_ERROR", "Email adapter has no SMTP config; cannot send.");
    }
    const subject =
      (message.metadata.subject as string | undefined) ??
      firstText(message.content)?.slice(0, 78) ??
      "(no subject)";
    const textParts: string[] = [];
    let html: string | undefined;
    const attachments: Array<{ filename?: string; path: string; cid?: string }> = [];

    for (const block of message.content) {
      switch (block.type) {
        case "text":
          if (block.format === "html") html = block.text;
          else textParts.push(block.text);
          break;
        case "image":
          attachments.push({
            path: block.url,
            ...(block.caption ? { filename: block.caption } : {}),
          });
          textParts.push(`[image: ${block.caption ?? block.url}]`);
          break;
        case "file":
          attachments.push({
            path: block.url,
            ...(block.filename ? { filename: block.filename } : {}),
          });
          textParts.push(`[file: ${block.filename ?? block.url}]`);
          break;
        case "template":
          textParts.push(
            `[template ${block.template}] ${Object.entries(block.params)
              .map(([k, v]) => `${k}=${v}`)
              .join(" ")}`
          );
          break;
        default:
          textParts.push(`[${block.type}]`);
      }
    }

    const info = await this.transporter.sendMail({
      from: this.opts.fromName
        ? { name: this.opts.fromName, address: this.opts.fromAddress }
        : this.opts.fromAddress,
      to: message.to,
      subject,
      text: textParts.join("\n\n"),
      ...(html ? { html } : {}),
      ...(attachments.length ? { attachments } : {}),
    });
    return { status: "sent", platformMessageId: info.messageId };
  }

  verifyWebhook(req: WebhookRequest): boolean {
    if (this.opts.verify) return this.opts.verify(req);
    // No default signature knowledge: warn but accept, so dev flows work.
    return true;
  }

  parseWebhook(req: WebhookRequest): PrismMessage[] {
    const provider = this.opts.inboundProvider ?? "generic";
    const body = (req.body ?? {}) as Record<string, unknown>;
    const msg = parseInbound(provider, body, req);
    return msg ? [msg] : [];
  }
}

// ---- inbound parsing -------------------------------------------------------

function parseInbound(
  provider: string,
  body: Record<string, unknown>,
  req: WebhookRequest
): PrismMessage | null {
  switch (provider) {
    case "sendgrid":
      return parseSendgrid(body);
    case "postmark":
      return parsePostmark(body);
    case "mailgun":
      return parseMailgun(body, req);
    default:
      return parseGeneric(body);
  }
}

function parseSendgrid(b: Record<string, unknown>): PrismMessage | null {
  const envelope = b.envelope as { from?: string; to?: string[] } | undefined;
  const from = str(b.from) ?? envelope?.from ?? "";
  const to = envelope?.to?.[0] ?? str(b.to) ?? "";
  const textBody = str(b.text) ?? "";
  const htmlBody = str(b.html) ?? "";
  if (!from) return null;
  return buildInboundEmail({
    from,
    to,
    subject: str(b.subject) ?? "(no subject)",
    text: textBody || stripTags(htmlBody),
    html: htmlBody || undefined,
    attachments: (b.attachments as Array<{ filename?: string; url?: string }> | undefined) ?? [],
    messageId: str(b["sg-message-id"]) ?? str(b.MessageID) ?? undefined,
  });
}

function parsePostmark(b: Record<string, unknown>): PrismMessage | null {
  const from = str(b.FromFull?.Email ?? b.From);
  if (!from) return null;
  return buildInboundEmail({
    from,
    to: str(b.ToFull?.[0]?.Email ?? b.To) ?? "",
    subject: str(b.Subject) ?? "(no subject)",
    text: str(b.TextBody) ?? "",
    html: str(b.HtmlBody) || undefined,
    attachments: (b.Attachments as Array<{ Name?: string; URL?: string }> | undefined) ?? [],
    messageId: str(b.MessageID),
  });
}

function parseMailgun(b: Record<string, unknown>, req: WebhookRequest): PrismMessage | null {
  const from = str(b.sender) ?? str(b.from) ?? "";
  if (!from) return null;
  return buildInboundEmail({
    from,
    to: str(b.recipient) ?? "",
    subject: str(b.subject) ?? "(no subject)",
    text: str(b["body-plain"]) ?? "",
    html: str(b["body-html"]) || undefined,
    attachments: (b.attachments as Array<{ filename?: string; url?: string }> | undefined) ?? [],
    messageId: str(b["Message-Id"]),
    signatureHint: str(req.headers["x-mailgun-signature"]),
  });
}

function parseGeneric(b: Record<string, unknown>): PrismMessage | null {
  const from = str(b.from) ?? "";
  if (!from) return null;
  return buildInboundEmail({
    from,
    to: str(b.to) ?? "",
    subject: str(b.subject) ?? "(no subject)",
    text: str(b.text) ?? stripTags(str(b.html) ?? ""),
    html: str(b.html) || undefined,
    attachments: (b.attachments as Array<{ filename?: string; url?: string }> | undefined) ?? [],
    messageId: str(b.messageId) ?? str(b.message_id),
  });
}

function buildInboundEmail(input: {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments: Array<{ filename?: string; URL?: string; url?: string; Name?: string }>;
  messageId?: string;
  signatureHint?: string;
}): PrismMessage {
  const content: ContentBlock[] = [];
  if (input.text) content.push({ type: "text", text: input.text });
  if (input.html) content.push({ type: "text", text: input.html, format: "html" });
  for (const a of input.attachments) {
    const url = a.url ?? a.URL ?? "";
    const name = a.filename ?? a.Name;
    if (url) content.push({ type: "file", url, ...(name ? { filename: name } : {}) });
  }
  if (content.length === 0) content.push({ type: "text", text: "" });
  return {
    id: deterministicId(
      "email",
      input.messageId ?? input.from,
      input.subject,
      input.text.slice(0, 128)
    ),
    channel: "email",
    direction: "inbound",
    from: input.from,
    to: input.to,
    content,
    timestamp: Date.now(),
    metadata: {
      subject: input.subject,
      ...(input.messageId ? { messageId: input.messageId } : {}),
    },
  };
}

function firstText(blocks: ContentBlock[]): string | undefined {
  for (const b of blocks) if (b.type === "text") return b.text;
  return undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function stripTags(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
