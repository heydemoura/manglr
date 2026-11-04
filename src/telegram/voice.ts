import type { Api } from "grammy";
import type { Voice } from "grammy/types";
import type { Config } from "../config.js";
import { createLocalTranscriber, VoiceError, type AudioTranscriber } from "./local-whisper.js";
export { VoiceError } from "./local-whisper.js";

// Telegram's hosted Bot API caps downloads at 20 MB.
export const MAX_VOICE_BYTES = 20 * 1024 * 1024;
const TOO_LARGE = "Voice messages must be 20 MB or smaller. Please send a shorter recording.";

export type VoiceTranscriber = (voice: Voice) => Promise<string>;

export function createVoiceTranscriber(
  cfg: Pick<Config, "telegram" | "transcription">,
  api: Pick<Api, "getFile">,
  fetcher: typeof fetch = fetch,
  transcribe: AudioTranscriber = createLocalTranscriber(cfg.transcription),
): VoiceTranscriber {
  return async (voice) => {
    if ((voice.file_size ?? 0) > MAX_VOICE_BYTES) throw new VoiceError(TOO_LARGE);

    let audio: Uint8Array<ArrayBuffer>;
    let filename: string;
    try {
      const file = await api.getFile(voice.file_id);
      if ((file.file_size ?? 0) > MAX_VOICE_BYTES) throw new VoiceError(TOO_LARGE);
      if (!file.file_path) throw new VoiceError("Telegram could not provide this voice message. Please send it again.");
      // Preserve known formats; Telegram recordings are normally Ogg/Opus.
      const ext = /\.(ogg|oga|mp3|m4a|mp4|wav|webm)$/i.exec(file.file_path)?.[1]?.toLowerCase() ?? "ogg";
      filename = `voice.${ext === "oga" ? "ogg" : ext}`;
      const response = await fetcher(`https://api.telegram.org/file/bot${cfg.telegram.token}/${file.file_path}`, {
        signal: AbortSignal.timeout(60_000),
        redirect: "error",
      });
      if (!response.ok) throw new VoiceError(`Could not download the voice message from Telegram (HTTP ${response.status}). Please try again.`);
      audio = await readAudio(response);
    } catch (err) {
      if (err instanceof VoiceError) throw err;
      throw new VoiceError("Could not download the voice message from Telegram. Please try again.");
    }

    try {
      const text = (await transcribe(audio, filename)).trim();
      if (!text) throw new VoiceError("No speech was recognized. Please record again, or send the prompt as text.");
      return text;
    } catch (err) {
      if (err instanceof VoiceError) throw err;
      throw new VoiceError("Could not transcribe the voice message with local Whisper. Please try again, or send the prompt as text.");
    }
  };
}

/** Bound the actual download too, even when Telegram omits the file size. */
async function readAudio(response: Response): Promise<Uint8Array<ArrayBuffer>> {
  if (Number(response.headers.get("content-length")) > MAX_VOICE_BYTES) {
    await response.body?.cancel();
    throw new VoiceError(TOO_LARGE);
  }
  if (!response.body) throw new VoiceError("The voice recording was empty. Please send it again.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_VOICE_BYTES) {
        await reader.cancel();
        throw new VoiceError(TOO_LARGE);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!size) throw new VoiceError("The voice recording was empty. Please send it again.");
  const audio = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    audio.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return audio;
}
