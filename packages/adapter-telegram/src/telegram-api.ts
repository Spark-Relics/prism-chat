import { PrismError } from "@prism/core";

/** Thin Telegram Bot API client. No SDK dependency, fetch only. */
export class TelegramApiClient {
  private readonly base: string;
  private readonly token: string;
  private abort: AbortController | null = null;
  private stopped = false;

  constructor(opts: { token: string; apiBase?: string; timeoutMs?: number }) {
    this.base = opts.apiBase ?? "https://api.telegram.org";
    this.token = opts.token;
    if (opts.timeoutMs) this.timeoutMs = opts.timeoutMs;
  }

  private timeoutMs = 30_000;

  async call<T>(method: string, payload?: Record<string, unknown>): Promise<T> {
    if (this.stopped) throw new PrismError("INTERNAL", "client stopped");
    this.abort = new AbortController();
    const timer = setTimeout(() => this.abort?.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.base}/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload ?? {}),
        signal: this.abort.signal,
      });
      const json = (await res.json()) as { ok: boolean; result?: T; description?: string };
      if (!json.ok) {
        const retryable = res.status >= 500 || res.status === 429;
        throw new PrismError(
          retryable ? "RATE_LIMITED" : "SEND_FAILED",
          `Telegram API ${method} failed: ${json.description ?? res.status}`,
          { retryable, detail: { status: res.status } }
        );
      }
      return json.result as T;
    } catch (err) {
      if (err instanceof PrismError) throw err;
      throw new PrismError("TIMEOUT", `Telegram API ${method} network error`, {
        retryable: true,
        cause: err,
      });
    } finally {
      clearTimeout(timer);
      this.abort = null;
    }
  }

  /** Long-poll getUpdates with the shared abort controller. */
  async getUpdates(offset: number, timeoutSec: number): Promise<TgUpdate[]> {
    this.abort = new AbortController();
    const timer = setTimeout(() => this.abort?.abort(), (timeoutSec + 10) * 1000);
    try {
      const url = new URL(`${this.base}/bot${this.token}/getUpdates`);
      url.searchParams.set("offset", String(offset));
      url.searchParams.set("timeout", String(timeoutSec));
      url.searchParams.set("allowed_updates", JSON.stringify(["message", "edited_message"]));
      const res = await fetch(url, { signal: this.abort.signal });
      const json = (await res.json()) as { ok: boolean; result?: TgUpdate[] };
      if (!json.ok) return [];
      return json.result ?? [];
    } catch {
      if (this.stopped) return [];
      return []; // network hiccup during long poll; next iteration retries
    } finally {
      clearTimeout(timer);
      this.abort = null;
    }
  }

  stopPolling(): void {
    this.stopped = true;
    this.abort?.abort();
  }
}

// ---- Minimal Telegram types (only what we consume) -----------------------

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
}

export interface TgMessage {
  message_id: number;
  date: number;
  chat: { id: number; type: string; title?: string; username?: string; first_name?: string };
  from?: { id: number; is_bot: boolean; first_name?: string; username?: string; language_code?: string };
  text?: string;
  caption?: string;
  photo?: Array<{ file_id: string; file_size?: number }>;
  audio?: { file_id: string; duration?: number };
  voice?: { file_id: string; duration?: number };
  video?: { file_id: string; duration?: number };
  document?: { file_id: string; filename?: string; mime_type?: string };
  sticker?: { file_id: string; emoji?: string };
  location?: { latitude: number; longitude: number };
  contact?: { phone_number?: string; first_name?: string; user_id?: number };
}
