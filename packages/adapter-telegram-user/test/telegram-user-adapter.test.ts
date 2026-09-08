import assert from "node:assert/strict";
import test from "node:test";
import { TelegramUserAdapter } from "@prism/adapter-telegram-user";

test("requires apiId and apiHash", () => {
  assert.throws(
    () => new TelegramUserAdapter({ apiId: 0, apiHash: "" }),
    /apiId and apiHash/
  );
});

test("requires session or phoneNumber", () => {
  assert.throws(
    () => new TelegramUserAdapter({ apiId: 1, apiHash: "h" }),
    /session.*phoneNumber|phoneNumber.*session/i
  );
});

test("accepts session without phoneNumber", () => {
  const a = new TelegramUserAdapter({ apiId: 1, apiHash: "h", session: "saved" });
  assert.equal(a.channel, "telegram-user");
  assert.equal(a.displayName, "Telegram (personal)");
});

test("capabilities and webhook behavior", () => {
  const a = new TelegramUserAdapter({ apiId: 1, apiHash: "h", session: "s" });
  const caps = a.capabilities();
  assert.equal(caps.features.webhook, false);
  assert.ok(caps.sendBlocks.includes("text"));
  // MTProto is not a webhook channel
  assert.equal(a.verifyWebhook(), false);
  assert.deepEqual(a.parseWebhook(), []);
});
