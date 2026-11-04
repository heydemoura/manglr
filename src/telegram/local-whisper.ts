import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Config } from "../config.js";

/** Only these messages are safe to show or log; raw errors can contain private data. */
export class VoiceError extends Error {}

const exec = promisify(execFile);
export type AudioTranscriber = (audio: Uint8Array, filename: string) => Promise<string>;

/** Downloading models is a setup step; inference never accesses the network. */
export function createLocalTranscriber(cfg: Config["transcription"]): AudioTranscriber {
  return async (audio, filename) => {
    try {
      await access(cfg.modelPath, constants.R_OK);
    } catch {
      throw new VoiceError("The local Whisper model is missing or unreadable. Set WHISPER_MODEL_PATH on the gateway (see README), then try again.");
    }
    const dir = await mkdtemp(path.join(tmpdir(), "manglr-voice-"));
    try {
      const input = path.join(dir, filename);
      const wav = path.join(dir, "audio.wav");
      const output = path.join(dir, "transcript");
      await writeFile(input, audio, { mode: 0o600 });
      try {
        await exec(cfg.ffmpegPath, [
          "-nostdin", "-hide_banner", "-loglevel", "error",
          "-protocol_whitelist", "file,pipe", "-i", input,
          "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", "-y", wav,
        ], { timeout: 60_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 });
      } catch (err) {
        if (isMissingExecutable(err)) throw new VoiceError("FFmpeg is not installed or FFMPEG_PATH is incorrect on the gateway. See README for setup.");
        throw new VoiceError("Could not decode the voice recording locally (FFmpeg failed or timed out). Please record again, or send the prompt as text.");
      }
      try {
        await exec(cfg.executable, [
          "--model", cfg.modelPath, "--file", wav, "--language", "auto",
          "--output-txt", "--output-file", output, "--no-prints", "--no-timestamps",
        ], { timeout: 300_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 });
      } catch (err) {
        if (isMissingExecutable(err)) throw new VoiceError("Whisper.cpp is not installed or WHISPER_PATH is incorrect on the gateway. See README for setup.");
        throw new VoiceError("Local Whisper transcription failed or timed out. Please try again, or send the prompt as text.");
      }
      let text: string;
      try {
        text = (await readFile(`${output}.txt`, "utf8")).trim();
      } catch {
        throw new VoiceError("Local Whisper did not produce a transcript. Check the model and runtime on the gateway, or send the prompt as text.");
      }
      if (!text) throw new VoiceError("No speech was recognized. Please record again, or send the prompt as text.");
      return text;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

function isMissingExecutable(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "ENOENT";
}
