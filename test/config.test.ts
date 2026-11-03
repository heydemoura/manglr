import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GATEWAY_ENV_KEYS, loadConfig } from "../src/config.js";

test("gateway settings, the bot token above all, are not inherited by agents", () => {
  const cwd = process.cwd();
  process.chdir(mkdtempSync(path.join(tmpdir(), "manglr-cfg-"))); // no .env here
  try {
    Object.assign(process.env, {
      TELEGRAM_BOT_TOKEN: "1:secret",
      TELEGRAM_CHAT_ID: "-1001",
      TELEGRAM_ALLOWED_USER_IDS: "42",
      CLAUDE_PERMISSION_MODE: "bypassPermissions",
      SOMETHING_FOR_AGENTS: "kept",
    });
    const cfg = loadConfig();
    assert.equal(cfg.telegram.token, "1:secret");
    assert.equal(cfg.claude.permissionMode, "bypassPermissions");
    for (const key of GATEWAY_ENV_KEYS) assert.equal(process.env[key], undefined, key);
    assert.equal(process.env.SOMETHING_FOR_AGENTS, "kept");

    // Also when the config is invalid.
    Object.assign(process.env, { TELEGRAM_BOT_TOKEN: "1:secret", TELEGRAM_CHAT_ID: "nope" });
    assert.throws(() => loadConfig(), /TELEGRAM_CHAT_ID/);
    assert.equal(process.env.TELEGRAM_BOT_TOKEN, undefined);
  } finally {
    delete process.env.SOMETHING_FOR_AGENTS;
    process.chdir(cwd);
  }
});
