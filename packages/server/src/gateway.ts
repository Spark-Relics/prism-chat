import Fastify, { type FastifyInstance } from "fastify";
import {
  PrismHub,
  consoleLogger,
  type PrismHubOptions,
  type WebhookRequest,
} from "@prism/core";
import { TelegramAdapter } from "@prism/adapter-telegram";
import type { TelegramAdapterOptions } from "@prism/adapter-telegram";
import { EmailAdapter } from "@prism/adapter-email";
import type { EmailAdapterOptions } from "@prism/adapter-email";
import { WhatsAppAdapter } from "@prism/adapter-whatsapp";
import type { WhatsAppAdapterOptions } from "@prism/adapter-whatsapp";
import { LineAdapter } from "@prism/adapter-line";
import type { LineAdapterOptions } from "@prism/adapter-line";

export interface GatewayChannels {
  telegram?: TelegramAdapterOptions;
  email?: EmailAdapterOptions;
  whatsapp?: WhatsAppAdapterOptions;
  line?: LineAdapterOptions;
}

export interface CreateGatewayOptions extends PrismHubOptions {
  channels: GatewayChannels;
  /** HTTP server port. */
  port?: number;
  /** Host binding. */
  host?: string;
  /**
   * Inbound message forwarding target: your business service.
   * POST { target } with the normalized PrismMessage as JSON body.
   */
  forwardUrl?: string;
  /** Bearer token required on /api/* endpoints (and used for forwardUrl). */
  apiToken?: string;
}

/**
 * Standalone Prism gateway:
 *   POST /hooks/:channel      — platform webhooks (verify + normalize + forward)
 *   GET  /hooks/whatsapp      — Meta subscription handshake
 *   POST /api/send            — unified outbound send (Prism OutboundMessage)
 *   GET  /api/channels        — registered channels + capabilities
 *   GET  /healthz             — liveness
 */
export async function createGateway(opts: CreateGatewayOptions): Promise<FastifyInstance> {
  const hub = new PrismHub({ logger: opts.logger ?? consoleLogger, ...opts });

  if (opts.channels.telegram) hub.use(new TelegramAdapter(opts.channels.telegram));
  if (opts.channels.email) hub.use(new EmailAdapter(opts.channels.email));
  if (opts.channels.whatsapp) hub.use(new WhatsAppAdapter(opts.channels.whatsapp));
  if (opts.channels.line) hub.use(new LineAdapter(opts.channels.line));

  if (opts.forwardUrl) {
    hub.onMessage(async (message) => {
      try {
        await fetch(opts.forwardUrl!, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(opts.apiToken ? { authorization: `Bearer ${opts.apiToken}` } : {}),
          },
          body: JSON.stringify(message),
        });
      } catch (err) {
        hub.logger.error("forward failed", { err: String(err) });
      }
    });
  }

  const app = Fastify({ logger: false, bodyLimit: 10 * 1024 * 1024 });

  // ---- webhook ingress ----------------------------------------------------

  app.addContentTypeParser(
    ["application/json", "text/plain"],
    { parseAs: "string" },
    (_req, body, done) => done(null, body as string)
  );

  app.post("/hooks/:channel", async (req, reply) => {
    const { channel } = req.params as { channel: string };
    const rawBody = typeof req.body === "string" ? req.body : "";
    let parsed: unknown;
    try {
      parsed = rawBody ? JSON.parse(rawBody) : undefined;
    } catch {
      parsed = undefined;
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") headers[k.toLowerCase()] = v;
    }
    const webReq: WebhookRequest = {
      headers,
      rawBody,
      body: parsed,
      query: (req.query as Record<string, string>) ?? {},
    };
    const result = await hub.handleWebhook(channel, webReq);
    reply.code(result.status).send(result.body);
  });

  // Meta/WhatsApp subscription handshake.
  app.get("/hooks/whatsapp", async (req, reply) => {
    const q = (req.query as Record<string, string>) ?? {};
    if (
      q["hub.mode"] === "subscribe" &&
      opts.channels.whatsapp?.verifyToken &&
      q["hub.verify_token"] === opts.channels.whatsapp.verifyToken
    ) {
      return reply.code(200).send(q["hub.challenge"] ?? "");
    }
    return reply.code(403).send("forbidden");
  });

  // ---- outbound API ---------------------------------------------------------

  app.get("/healthz", async () => ({ ok: true, channels: hub.listChannels() }));

  app.get("/api/channels", async (req, reply) => {
    if (!checkToken(req.headers.authorization, opts.apiToken)) {
      return reply.code(401).send("unauthorized");
    }
    return hub.listChannels().map((c) => ({
      ...c,
      capabilities: hub.capabilities(c.id),
    }));
  });

  app.post("/api/send", async (req, reply) => {
    if (!checkToken(req.headers.authorization, opts.apiToken)) {
      return reply.code(401).send("unauthorized");
    }
    const message = req.body as { channel: string; to: string; content: unknown };
    if (!message?.channel || !message?.to || !Array.isArray(message.content)) {
      return reply.code(400).send("channel, to and content[] required");
    }
    const result = await hub.send(message as never);
    return reply.code(202).send(result);
  });

  // ---- lifecycle ------------------------------------------------------------

  app.addHook("onClose", async () => {
    await hub.stop();
  });

  const port = opts.port ?? 3000;
  const host = opts.host ?? "0.0.0.0";
  await app.listen({ port, host });
  await hub.start();
  hub.logger.info(`prism gateway listening`, { port, channels: hub.listChannels() });
  return app;
}

function checkToken(authHeader: string | undefined, expected: string | undefined): boolean {
  if (!expected) return true;
  return authHeader === `Bearer ${expected}`;
}
