import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CodexSession } from "../src/agents/codex.js";
import type { AgentEvents } from "../src/agents/types.js";

/** A stand-in `codex` binary: reports a failed turn on stdout, then exits 1 like the real one. */
function fakeCodex(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "manglr-codex-"));
  const bin = path.join(dir, "codex");
  const events = [
    { type: "thread.started", thread_id: "t-1" },
    { type: "turn.started" },
    { type: "error", message: "Reconnecting... 1/5" },
    { type: "turn.failed", error: { message: "stream disconnected before completion: Unable to verify model access right now. Please retry." } },
  ];
  writeFileSync(
    bin,
    `#!/bin/sh\ncat >/dev/null\necho "Reading prompt from stdin..." >&2\n` +
      events.map((e) => `echo '${JSON.stringify(e)}'`).join("\n") +
      "\nexit 1\n",
  );
  chmodSync(bin, 0o755);
  return bin;
}

test("a failed Codex turn reports Codex's reason, not the exit code", async () => {
  let resolve!: (info: { error?: string; interrupted?: boolean }) => void;
  const ended = new Promise<{ error?: string; interrupted?: boolean }>((r) => (resolve = r));
  const events = {
    turnStarted: () => {},
    turnEnded: (info: { error?: string; interrupted?: boolean }) => resolve(info),
    reply: () => {},
    progress: () => {},
    sessionId: () => {},
  } as unknown as AgentEvents;
  const session = new CodexSession(
    { sandboxMode: "read-only", networkAccess: false, executable: fakeCodex() } as any,
    { cwd: tmpdir() },
    events,
  );
  session.send("hi");
  const info = await ended;
  assert.equal(info.interrupted, false);
  assert.equal(info.error, "stream disconnected before completion: Unable to verify model access right now. Please retry.");
});
