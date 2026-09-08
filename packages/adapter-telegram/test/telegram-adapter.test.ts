import assert from "node:assert/strict";
import test from "node:test";
import { TelegramAdapter } from "@prism/adapter-telegram";
import type { WebhookRequest } from "@prism/core";

const adapter = new TelegramAdapter({ botToken: "test-token" });

function req(body: unknown): WebhookRequest {
  return {
    headers: {},
    rawBody: JSON.stringify(body),
    body,
  };
}

test("text message converts to PrismMessage", () => {
  const messages = adapter.parseWebhook(
    req({
      update_id: 1001,
      message: {
        message_id: 42,
        date: 1700000000,
        text: "hello world",
        chat: { id: 12345, type: "private" },
        from: { id: 12345, is_bot: false, first_name: "User" },
      },
    })
  );
  assert.equal(messages.length, 1);
  const m = messages[0];
  assert.equal(m.channel, "telegram");
  assert.equal(m.direction, "inbound");
  assert.equal(m.from, "12345");
  assert.deepEqual(m.content, [{ type: "text", text: "hello world" }]);
  assert.equal(m.metadata.tgMessageId, 42);
});

test("photo message picks the largest size and keeps caption", () => {
  const messages = adapter.parseWebhook(
    req({
      update_id: 1002,
      message: {
        message_id: 43,
        date: 1700000000,
        photo: [{ file_id: "small", width: 90 }, { file_id: "large", width: 1280 }],
        caption: "pic",
        chat: { id: 99, type: "private" },
      },
    })
  );
  assert.equal(messages.length, 1);
  const img = messages[0].content[0];
  assert.equal(img.type, "image");
  assert.equal((img as { url?: string }).url, "large");
});

test("document message converts to file block", () => {
  const messages = adapter.parseWebhook(
    req({
      update_id: 1003,
      message: {
        message_id: 44,
        date: 1700000000,
        document: { file_id: "doc-1", filename: "report.pdf", mime_type: "application/pdf" },
        chat: { id: 7, type: "private" },
      },
    })
  );
  const file = messages[0].content[0] as { type: string; filename?: string; mimetype?: string };
  assert.equal(file.type, "file");
  assert.equal(file.filename, "report.pdf");
  assert.equal(file.mimetype, "application/pdf");
});

test("update without message returns empty", () => {
  assert.deepEqual(adapter.parseWebhook(req({ update_id: 1, callback_query: {} })), []);
  assert.deepEqual(adapter.parseWebhook(req(undefined)), []);
});

test("webhook verification rejects without matching secret", () => {
  const a = new TelegramAdapter({ botToken: "t", mode: "webhook", secretToken: "s3cret" });
  assert.equal(
    a.verifyWebhook({
      headers: { "x-telegram-bot-api-secret-token": "s3cret" },
      rawBody: "",
      body: {},
    }),
    true
  );
  assert.equal(
    a.verifyWebhook({
      headers: { "x-telegram-bot-api-secret-token": "wrong" },
      rawBody: "",
      body: {},
    }),
    false
  );
  // polling mode never accepts webhooks
  assert.equal(
    adapter.verifyWebhook({
      headers: { "x-telegram-bot-api-secret-token": "" },
      rawBody: "",
      body: {},
    }),
    false
  );
});
