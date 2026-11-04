import { test } from "node:test";
import assert from "node:assert/strict";
import { Api, GrammyError } from "grammy";
import { ignoreNotModified } from "../src/telegram/not-modified.js";

function api(response: Record<string, unknown>) {
  const a = new Api("1:fake");
  a.config.use(async () => response as any); // stands in for Telegram
  a.config.use(ignoreNotModified);
  return a;
}

const notModified = {
  ok: false,
  error_code: 400,
  description: "Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message",
};

test("editing a message to what it already shows succeeds", async () => {
  assert.equal(await api(notModified).editMessageText(-1001, 5, "same"), true);
  assert.equal(await api(notModified).editMessageReplyMarkup(-1001, 5), true);
});

test("other errors still fail", async () => {
  await assert.rejects(
    api({ ok: false, error_code: 400, description: "Bad Request: message to edit not found" }).editMessageText(-1001, 5, "x"),
    (err) => err instanceof GrammyError && /not found/.test(err.description),
  );
  await assert.rejects(api(notModified).sendMessage(-1001, "x"), GrammyError); // only edits are no-ops
});
