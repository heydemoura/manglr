import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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
      TOPIC_TITLE_MODEL: "sonnet",
      WHISPER_MODEL_PATH: "~/models/whisper.bin",
      WHISPER_PATH: "~/bin/whisper-cli",
      FFMPEG_PATH: "/opt/homebrew/bin/ffmpeg",
      SOMETHING_FOR_AGENTS: "kept",
    });
    const cfg = loadConfig();
    assert.equal(cfg.telegram.token, "1:secret");
    assert.equal(cfg.claude.permissionMode, "bypassPermissions");
    assert.equal(cfg.topicTitleModel, "sonnet");
    assert.deepEqual(cfg.transcription, {
      modelPath: path.join(homedir(), "models/whisper.bin"),
      executable: path.join(homedir(), "bin/whisper-cli"),
      ffmpegPath: "/opt/homebrew/bin/ffmpeg",
    });
    for (const key of GATEWAY_ENV_KEYS) assert.equal(process.env[key], undefined, key);
    assert.equal(process.env.SOMETHING_FOR_AGENTS, "kept");

    // Also when the config is invalid.
    Object.assign(process.env, { TELEGRAM_BOT_TOKEN: "1:secret", TELEGRAM_CHAT_ID: "nope", WHISPER_MODEL_PATH: "model.bin" });
    assert.throws(() => loadConfig(), /TELEGRAM_CHAT_ID/);
    assert.equal(process.env.TELEGRAM_BOT_TOKEN, undefined);
    assert.equal(process.env.WHISPER_MODEL_PATH, undefined);

    Object.assign(process.env, { TELEGRAM_BOT_TOKEN: "1:secret" });
    const defaults = loadConfig();
    assert.equal(defaults.topicTitleModel, "haiku");
    assert.deepEqual(defaults.transcription, {
      modelPath: path.join(homedir(), ".cache/manglr/ggml-small.bin"),
      executable: "whisper-cli",
      ffmpegPath: "ffmpeg",
    });
  } finally {
    delete process.env.SOMETHING_FOR_AGENTS;
    process.chdir(cwd);
  }
});
