import assert from "node:assert/strict";
import test from "node:test";
import { EmailAdapter } from "@prism/adapter-email";
import type { WebhookRequest } from "@prism/core";

function make(provider?: "sendgrid" | "postmark" | "mailgun" | "generic") {
  return new EmailAdapter({
    fromAddress: "bot@example.com",
    ...(provider ? { inboundProvider: provider } : {}),
  });
}

function req(headers: Record<string, string>, body: unknown): WebhookRequest {
  return { headers, rawBody: JSON.stringify(body), body };
}

/** parseWebhook must return exactly one message; asserts and returns it. */
function one(a: EmailAdapter, r: WebhookRequest) {
  const messages = a.parseWebhook(r);
  assert.equal(messages.length, 1, `expected 1 message, got ${messages.length}`);
  return messages[0];
}

test("postmark: FromFull / ToFull preferred over plain fields", () => {
  const m = one(
    make("postmark"),
    req(
      {},
      {
        FromFull: { Email: "from@x.com", Name: "From" },
        ToFull: [{ Email: "bot@example.com" }, { Email: "other@example.com" }],
        From: "legacy-from@x.com",
        To: "legacy-to@example.com",
        Subject: "Hi",
        TextBody: "plain body",
        HtmlBody: "<p>rich</p>",
        MessageID: "pm-1",
      }
    )
  );
  assert.equal(m.from, "from@x.com");
  assert.equal(m.to, "bot@example.com");
  assert.equal(m.metadata.subject, "Hi");
  const texts = m.content.filter((b) => b.type === "text");
  assert.deepEqual(
    texts.map((b) => (b as { text: string }).text),
    ["plain body", "<p>rich</p>"]
  );
  assert.equal(m.metadata.messageId, "pm-1");
});

test("postmark: falls back to From when FromFull missing", () => {
  const m = one(make("postmark"), req({}, { From: "only@x.com", Subject: "s", TextBody: "t" }));
  assert.equal(m.from, "only@x.com");
});

test("sendgrid: envelope + attachments", () => {
  const m = one(
    make("sendgrid"),
    req(
      {},
      {
        envelope: { from: "sg@x.com", to: ["bot@example.com"] },
        subject: "SG",
        text: "sg body",
        html: "",
        attachments: [{ filename: "a.txt", url: "https://files/a.txt" }],
        "sg-message-id": "sg-1",
      }
    )
  );
  assert.equal(m.from, "sg@x.com");
  assert.equal(m.to, "bot@example.com");
  const file = m.content.find((b) => b.type === "file") as { url?: string; filename?: string };
  assert.equal(file.url, "https://files/a.txt");
  assert.equal(file.filename, "a.txt");
});

test("mailgun: body-plain + subject parsed", () => {
  const m = one(
    make("mailgun"),
    req(
      { "x-mailgun-signature": "sig" },
      {
        sender: "mg@x.com",
        recipient: "bot@example.com",
        subject: "MG",
        "body-plain": "mg body",
        "Message-Id": "mg-1",
      }
    )
  );
  assert.equal(m.from, "mg@x.com");
  assert.equal(m.metadata.subject, "MG");
});

test("generic: html stripped when no text", () => {
  const m = one(make(), req({}, { from: "g@x.com", subject: "G", html: "<p>styled</p>" }));
  const text = m.content[0] as { type: string; text: string };
  assert.equal(text.type, "text");
  assert.equal(text.text, "styled");
});

test("missing from returns empty in every provider", () => {
  for (const p of ["sendgrid", "postmark", "mailgun", "generic"] as const) {
    assert.deepEqual(make(p).parseWebhook(req({}, { subject: "no from" })), [], p);
  }
});
