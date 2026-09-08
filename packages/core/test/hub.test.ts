import assert from "node:assert/strict";
import test, { after } from "node:test";
import { PrismHub } from "@prism/core";
import type { ChannelAdapter } from "@prism/core";
import type {
  DeliveryResult,
  OutboundMessage,
  PrismMessage,
  WebhookRequest,
  WebhookResult,
} from "@prism/core";

class FakeAdapter implements ChannelAdapter {
  readonly channel: string;
  readonly displayName = "Fake";
  readonly requiredConfigKeys = [] as const;
  sent: PrismMessage[] = [];
  failFirstN = 0;

  constructor(channel: string) {
    this.channel = channel;
  }

  capabilities() {
    return {
      sendBlocks: ["text"] as const,
      receiveBlocks: ["text"] as const,
      features: { webhook: false, receipts: false, interactive: false },
    };
  }
  async start() {}
  async stop() {}
  async send(message: PrismMessage): Promise<DeliveryResult> {
    if (this.failFirstN > 0) {
      this.failFirstN--;
      throw new Error("boom");
    }
    this.sent.push(message);
    return { status: "sent", platformMessageId: "mid" };
  }
  verifyWebhook(_req: WebhookRequest): boolean {
    return true;
  }
  parseWebhook(_req: WebhookRequest): PrismMessage[] {
    return [];
  }
}

function outbound(text = "hello"): OutboundMessage {
  return {
    channel: "fake",
    to: "user-1",
    content: [{ type: "text", text }],
  };
}

function inbound(id: string): PrismMessage {
  return {
    id,
    channel: "fake",
    direction: "inbound",
    from: "user-1",
    to: "bot",
    content: [{ type: "text", text: "hi" }],
    timestamp: Date.now(),
    metadata: {},
  };
}

after(async () => {
  await hub?.stop();
});

let hub: PrismHub | undefined;
async function makeHub(opts?: ConstructorParameters<typeof PrismHub>[0]) {
  hub = new PrismHub(opts);
  return hub;
}

test("send delivers through outbox and emits delivered", async () => {
  const adapter = new FakeAdapter("fake");
  const h = await makeHub();
  h.use(adapter);
  await h.start();
  const delivered = new Promise<void>((r) => h.once("delivered", () => r()));
  const result = await h.send(outbound());
  assert.equal(result.status, "queued");
  await delivered;
  assert.equal(adapter.sent.length, 1);
  assert.equal(adapter.sent[0].to, "user-1");
});

test("inbound duplicate is dropped", async () => {
  const h = await makeHub();
  h.use(new FakeAdapter("fake"));
  await h.start();
  const seen: string[] = [];
  h.onMessage((m) => void seen.push(m.id));
  await h.ingest([inbound("a"), inbound("a"), inbound("b")]);
  assert.deepEqual(seen, ["a", "b"]);
});

test("failing sends retry with backoff then dead-letter", async () => {
  const adapter = new FakeAdapter("fake");
  adapter.failFirstN = 3;
  const h = await makeHub({
    outbox: { maxAttempts: 3, baseBackoffMs: 1 },
  });
  h.use(adapter);
  await h.start();
  const dead = new Promise<void>((r) => h.once("dead_letter", () => r()));
  await h.send(outbound("retry-me"));
  await dead;
  assert.equal(adapter.sent.length, 0);
});

test("unknown channel throws on send", async () => {
  const h = await makeHub();
  await h.start();
  await assert.rejects(() => h.send(outbound()), /ChannelNotFoundError|not registered/);
});

test("webhook passes through verify and parse", async () => {
  const h = await makeHub();
  h.use(
    new (class extends FakeAdapter {
      override parseWebhook(): PrismMessage[] {
        return [inbound("w1")];
      }
    })("fake")
  );
  await h.start();
  const seen: string[] = [];
  h.onMessage((m) => void seen.push(m.id));
  const res: WebhookResult = await h.handleWebhook("fake", {
    headers: {},
    rawBody: "{}",
    body: {},
  });
  assert.equal(res.status, 200);
  assert.deepEqual(seen, ["w1"]);
});
