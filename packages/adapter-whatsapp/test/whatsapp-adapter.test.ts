import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { WhatsAppAdapter } from "@prism/adapter-whatsapp";
import type { WebhookRequest } from "@prism/core";

const APP_SECRET = "app-secret-1";

function make() {
  return new WhatsAppAdapter({
    phoneNumberId: "123",
    accessToken: "token",
    appSecret: APP_SECRET,
  });
}

function req(body: unknown, signature: string): WebhookRequest {
  const rawBody = typeof body === "string" ? body : JSON.stringify(body);
  return {
    headers: { "x-hub-signature-256": signature },
    rawBody,
    body: typeof body === "string" ? {} : body,
  };
}

function sign(rawBody: string, secret = APP_SECRET): string {
  return "sha256=" + createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

test("valid signature accepted", () => {
  const body = { object: "whatsapp_business_account" };
  const raw = JSON.stringify(body);
  assert.equal(make().verifyWebhook(req(body, sign(raw))), true);
});

test("tampered body rejected", () => {
  const a = make();
  const good = sign(JSON.stringify({ a: 1 }));
  // signature computed for a different payload
  assert.equal(a.verifyWebhook(req({ a: 2 }, good)), false);
});

test("wrong secret rejected", () => {
  const raw = JSON.stringify({ a: 1 });
  assert.equal(make().verifyWebhook(req({ a: 1 }, sign(raw, "other-secret"))), false);
});

test("missing signature header rejected when appSecret configured", () => {
  const a = make();
  assert.equal(
    a.verifyWebhook({ headers: {}, rawBody: "{}", body: {} }),
    false
  );
});

test("no appSecret configured accepts (dev mode)", () => {
  const dev = new WhatsAppAdapter({ phoneNumberId: "1", accessToken: "t" });
  assert.equal(dev.verifyWebhook({ headers: {}, rawBody: "{}", body: {} }), true);
});

test("inbound text webhook parses into PrismMessage", () => {
  const a = make();
  const body = {
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                {
                  from: "8613800000000",
                  id: "wamid.1",
                  timestamp: "1700000000",
                  type: "text",
                  text: { body: "hi there" },
                },
              ],
            },
          },
        ],
      },
    ],
  };
  const raw = JSON.stringify(body);
  const messages = a.parseWebhook(req(body, sign(raw)));
  assert.equal(messages.length, 1);
  const m = messages[0];
  assert.equal(m.channel, "whatsapp");
  assert.equal(m.direction, "inbound");
  assert.equal(m.from, "8613800000000");
  assert.deepEqual(m.content, [{ type: "text", text: "hi there" }]);
  assert.equal(m.metadata.waId, "wamid.1");
});
