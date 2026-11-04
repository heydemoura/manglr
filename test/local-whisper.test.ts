import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLocalTranscriber, VoiceError } from "../src/telegram/local-whisper.js";

/** Real child processes with tiny stand-ins for FFmpeg and Whisper. */
async function fixture(t: TestContext, mode = "ok") {
  const dir = await mkdtemp(path.join(tmpdir(), "manglr-whisper-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const modelPath = path.join(dir, "model with spaces.bin");
  const ffmpegPath = path.join(dir, "fake ffmpeg.cjs");
  const executable = path.join(dir, "fake whisper.cjs");
  const log = path.join(dir, "calls.jsonl");
  await writeFile(modelPath, "model");
  const prelude = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
`;
  await writeFile(ffmpegPath, prelude + (mode === "decode-error" ? "process.exit(1);" : `fs.writeFileSync(args.at(-1), 'wav');`), { mode: 0o700 });
  await writeFile(executable, prelude + (mode === "inference-error" ? `process.stderr.write('private runtime output'); process.exit(1);`
    : mode === "no-output" ? "process.exit(0);"
    : `fs.writeFileSync(args[args.indexOf('--output-file') + 1] + '.txt', ${JSON.stringify(mode === "empty" ? "  " : "  Corrija o login.\nMais detalhes.  ")});`), { mode: 0o700 });
  const cfg = { modelPath, ffmpegPath, executable };
  const calls = async (): Promise<string[][]> => (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  return { cfg, calls };
}

async function assertCleaned(calls: string[][]) {
  const input = calls[0]![calls[0]!.indexOf("-i") + 1]!;
  await assert.rejects(access(path.dirname(input)), { code: "ENOENT" });
}

test("decodes locally, auto-detects language, returns the transcript, and deletes temporary files", async (t) => {
  const h = await fixture(t);
  const text = await createLocalTranscriber(h.cfg)(new Uint8Array([1, 2, 3]), "voice.ogg");
  assert.equal(text, "Corrija o login.\nMais detalhes.");
  const calls = await h.calls();
  assert.equal(calls.length, 2);
  assert.equal(calls[0]![calls[0]!.indexOf("-ar") + 1], "16000");
  assert.equal(calls[0]![calls[0]!.indexOf("-ac") + 1], "1");
  assert.equal(calls[0]![calls[0]!.indexOf("-protocol_whitelist") + 1], "file,pipe");
  assert.equal(calls[1]![calls[1]!.indexOf("--language") + 1], "auto");
  assert.equal(calls[1]![calls[1]!.indexOf("--model") + 1], h.cfg.modelPath);
  assert.ok(!calls[1]!.includes("--translate"), "preserves the recording's language");
  await assertCleaned(calls);
});

test("missing model reports setup instructions without starting the decoder", async (t) => {
  const h = await fixture(t);
  await rm(h.cfg.modelPath);
  await assert.rejects(createLocalTranscriber(h.cfg)(new Uint8Array([1]), "voice.ogg"), /WHISPER_MODEL_PATH/);
  await assert.rejects(h.calls(), { code: "ENOENT" });
});

for (const [mode, message] of [
  ["decode-error", /decode.*FFmpeg/],
  ["inference-error", /Local Whisper transcription failed/],
  ["no-output", /did not produce a transcript/],
  ["empty", /No speech was recognized/],
] as const) {
  test(`${mode} reports a safe error and removes temporary files`, async (t) => {
    const h = await fixture(t, mode);
    await assert.rejects(createLocalTranscriber(h.cfg)(new Uint8Array([1]), "voice.ogg"), (err: unknown) => {
      assert.ok(err instanceof VoiceError);
      assert.match(err.message, message);
      assert.doesNotMatch(err.message, /private runtime output/);
      return true;
    });
    const calls = await h.calls();
    if (mode === "decode-error") assert.equal(calls.length, 1, "Whisper is never started on a decode failure");
    await assertCleaned(calls);
  });
}

test("missing executable errors identify the dependency", async (t) => {
  const h = await fixture(t);
  await rm(h.cfg.executable);
  await assert.rejects(createLocalTranscriber(h.cfg)(new Uint8Array([1]), "voice.ogg"), /WHISPER_PATH/);
  await assertCleaned(await h.calls());
  await rm(h.cfg.ffmpegPath);
  await assert.rejects(createLocalTranscriber(h.cfg)(new Uint8Array([1]), "voice.ogg"), /FFMPEG_PATH/);
});
