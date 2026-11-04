import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config } from "../src/config.js";
import { createVoiceTranscriber, MAX_VOICE_BYTES, VoiceError } from "../src/telegram/voice.js";
import type { AudioTranscriber } from "../src/telegram/local-whisper.js";

const VOICE = { file_id: "voice-id", file_unique_id: "unique", duration: 3, mime_type: "audio/ogg" };
const FILE = { file_id: VOICE.file_id, file_unique_id: VOICE.file_unique_id, file_path: "voice/file_1.oga" };
const CONFIG: Pick<Config, "telegram" | "transcription"> = {
  telegram: { token: "1:telegram-secret", allowedUserIds: new Set() },
  transcription: { modelPath: "/models/whisper.bin", executable: "whisper-cli", ffmpegPath: "ffmpeg" },
};

function harness(responses: (Response | Error)[], options: { file?: typeof FILE; transcribe?: AudioTranscriber } = {}) {
  const requests: string[] = [];
  const files: string[] = [];
  const recordings: { audio: Uint8Array; filename: string }[] = [];
  const transcribe = createVoiceTranscriber(CONFIG, {
    getFile: async (id: string) => { files.push(id); return options.file ?? FILE; },
  }, async (url) => {
    requests.push(String(url));
    const result = responses.shift();
    if (result instanceof Error) throw result;
    assert.ok(result, "unexpected network request");
    return result;
  }, async (audio, filename) => {
    recordings.push({ audio, filename });
    return options.transcribe ? options.transcribe(audio, filename) : "  Corrija o erro de login.\nMais detalhes.  ";
  });
  return { transcribe, requests, files, recordings };
}

const audio = () => new Response(new Uint8Array([79, 103, 103, 83]));

test("downloads Telegram voice and transcribes it locally with no further network requests", async () => {
  const h = harness([audio()]);
  assert.equal(await h.transcribe(VOICE), "Corrija o erro de login.\nMais detalhes.");
  assert.deepEqual(h.files, [VOICE.file_id]);
  assert.deepEqual(h.requests, [`https://api.telegram.org/file/bot${CONFIG.telegram.token}/${FILE.file_path}`]);
  assert.deepEqual(h.recordings, [{ audio: new Uint8Array([79, 103, 103, 83]), filename: "voice.ogg" }]);
});

test("mp3 voice format is preserved for the local decoder", async () => {
  const h = harness([audio()], { file: { ...FILE, file_path: "voice/recording.mp3" } });
  await h.transcribe({ ...VOICE, mime_type: "audio/mpeg" });
  assert.equal(h.recordings[0]!.filename, "voice.mp3");
});

test("oversized voice metadata fails before fetching a file", async () => {
  const h = harness([]);
  await assert.rejects(h.transcribe({ ...VOICE, file_size: MAX_VOICE_BYTES + 1 }), /20 MB/);
  assert.deepEqual(h.files, []);
  assert.deepEqual(h.requests, []);
});

test("size from getFile is checked before downloading", async () => {
  const file = { ...FILE, file_size: MAX_VOICE_BYTES + 1 };
  const h = harness([], { file });
  await assert.rejects(h.transcribe(VOICE), /20 MB/);
  assert.deepEqual(h.requests, []);
});

test("a missing Telegram file path does not attempt a download", async () => {
  const h = harness([], { file: { ...FILE, file_path: "" } });
  await assert.rejects(h.transcribe(VOICE), /Telegram could not provide/);
  assert.deepEqual(h.requests, []);
});

test("actual downloads are bounded even without size metadata", async () => {
  const h = harness([new Response(new Uint8Array(MAX_VOICE_BYTES + 1))]);
  await assert.rejects(h.transcribe(VOICE), /20 MB/);
  assert.deepEqual(h.recordings, [], "oversized audio never goes to Whisper");
  const declared = harness([new Response("small", { headers: { "content-length": String(MAX_VOICE_BYTES + 1) } })]);
  await assert.rejects(declared.transcribe(VOICE), /20 MB/);
  assert.deepEqual(declared.recordings, []);
});

test("empty audio never goes to Whisper", async () => {
  const h = harness([new Response("")]);
  await assert.rejects(h.transcribe(VOICE), /recording was empty/);
  assert.deepEqual(h.recordings, []);
});

test("Telegram download errors hide the token-bearing URL", async () => {
  const h = harness([new Error(`network failed: https://api.telegram.org/file/bot${CONFIG.telegram.token}/voice.ogg`)]);
  await assert.rejects(h.transcribe(VOICE), (err: unknown) => {
    assert.ok(err instanceof VoiceError);
    assert.match(err.message, /download/);
    assert.doesNotMatch(err.message, /telegram-secret/);
    return true;
  });
  const http = harness([new Response("private data", { status: 404 })]);
  await assert.rejects(http.transcribe(VOICE), /Telegram \(HTTP 404\)/);
});

test("empty speech and local inference errors never become agent prompts", async () => {
  const empty = harness([audio()], { transcribe: async () => "   " });
  await assert.rejects(empty.transcribe(VOICE), /No speech/);
  const failed = harness([audio()], { transcribe: async () => { throw new Error("private runtime output"); } });
  await assert.rejects(failed.transcribe(VOICE), (err: unknown) => {
    assert.ok(err instanceof VoiceError);
    assert.match(err.message, /local Whisper/);
    assert.doesNotMatch(err.message, /private runtime output/);
    return true;
  });
});
