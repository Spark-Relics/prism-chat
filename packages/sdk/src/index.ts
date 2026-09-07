/**
 * @prism/sdk — one-line hub creation with a pluggable adapter registry.
 *
 *   import { createPrism, text } from "@prism/sdk";
 *   const prism = createPrism({ channels: { telegram: { botToken: "..." } } });
 *   await prism.start();
 *   prism.onMessage(async (m) => { await prism.send({ ...m, content: [text("hi")] }); });
 *
 * Custom adapters: registerPlugin / unregisterPlugin, or pass `adapters`.
 */
import {
  PrismHub,
  type ChannelAdapter,
  type PrismHubOptions,
} from "@prism/core";
import { TelegramAdapter } from "@prism/adapter-telegram";
import type { TelegramAdapterOptions } from "@prism/adapter-telegram";
import { EmailAdapter } from "@prism/adapter-email";
import type { EmailAdapterOptions } from "@prism/adapter-email";
import { WhatsAppAdapter } from "@prism/adapter-whatsapp";
import type { WhatsAppAdapterOptions } from "@prism/adapter-whatsapp";
import { LineAdapter } from "@prism/adapter-line";
import type { LineAdapterOptions } from "@prism/adapter-line";

export * from "@prism/core";

// ---- plugin registry -------------------------------------------------------

export type PluginFactory = (options: unknown) => ChannelAdapter;

const registry = new Map<string, PluginFactory>([
  ["telegram", (o) => new TelegramAdapter(o as TelegramAdapterOptions)],
  ["email", (o) => new EmailAdapter(o as EmailAdapterOptions)],
  ["whatsapp", (o) => new WhatsAppAdapter(o as WhatsAppAdapterOptions)],
  ["line", (o) => new LineAdapter(o as LineAdapterOptions)],
]);

/** Register or replace a channel plugin factory (for new platforms). */
export function registerPlugin(channel: string, factory: PluginFactory): void {
  registry.set(channel, factory);
}

export function unregisterPlugin(channel: string): void {
  registry.delete(channel);
}

export function listPlugins(): string[] {
  return [...registry.keys()];
}

// ---- factory ----------------------------------------------------------------

export interface CreatePrismOptions extends PrismHubOptions {
  /**
   * Channel configs keyed by channel id. Built-in channels are resolved from
   * the registry; unknown ids must be provided via `adapters`.
   */
  channels?: Record<string, unknown>;
  /** Pre-built adapters (takes precedence over `channels` for the same id). */
  adapters?: ChannelAdapter[];
}

/**
 * The hub instance returned by {@link createPrism}. Extends PrismHub; see
 * PrismHub for the full API surface (send / onMessage / handleWebhook / ...).
 */
export type Prism = PrismHub;

export function createPrism(opts: CreatePrismOptions = {}): Prism {
  const { channels, adapters, ...hubOptions } = opts;
  const hub = new PrismHub(hubOptions);

  const preBuilt = new Map((adapters ?? []).map((a) => [a.channel, a]));
  for (const [channel, options] of Object.entries(channels ?? {})) {
    const factory = registry.get(channel);
    if (!factory) {
      throw new Error(
        `Unknown channel "${channel}". registerPlugin("${channel}", factory) first or pass an adapter.`
      );
    }
    hub.use(factory(options));
  }
  for (const adapter of preBuilt.values()) hub.use(adapter);

  return hub as Prism;
}
