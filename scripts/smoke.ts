/**
 * Drive one agent session from the terminal, without Telegram, to check the
 * adapters: prints every event and answers permission prompts automatically.
 *
 *   npm run smoke -- claude "create hello.txt containing hi" [folder]
 *   npm run smoke -- codex "what files are here?" [folder]
 *
 * Without a folder it works in a fresh temp directory. SMOKE_RESUME=<session id>
 * resumes a session; SMOKE_MODEL=<model> picks the model; SMOKE_PERMISSION=deny
 * denies every permission request.
 */
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ClaudeSession } from "../src/agents/claude.js";
import { CodexSession } from "../src/agents/codex.js";
import type { AgentEvents, AgentSession } from "../src/agents/types.js";

const [kind, prompt, folder] = process.argv.slice(2);
if ((kind !== "claude" && kind !== "codex") || !prompt) {
  console.error('usage: npm run smoke -- <claude|codex> "<prompt>" [folder]');
  process.exit(2);
}
const cwd = realpathSync(folder ? path.resolve(folder) : mkdtempSync(path.join(tmpdir(), "manglr-smoke-")));
const answer = (process.env.SMOKE_PERMISSION ?? "allow") as "allow" | "deny";
console.log(`▶ ${kind} in ${cwd}`);

let done!: () => void;
const finished = new Promise<void>((r) => (done = r));

const events: AgentEvents = {
  sessionId: (id) => console.log(`🆔 session ${id}`),
  turnStarted: () => console.log("⏳ turn started"),
  progress: (line) => console.log(`   ${line}`),
  reply: (text, final) => console.log(`${final ? "💬 FINAL" : "💬"} ${text}`),
  turnEnded: (info) => {
    console.log("🏁 turn ended", info);
    done();
  },
  askPermission: async (req) => {
    console.log(`🔐 ${req.tool}: ${req.summary}${req.reason ? ` (${req.reason})` : ""} → ${answer}`);
    return answer;
  },
};

const init = { cwd, resume: process.env.SMOKE_RESUME, model: process.env.SMOKE_MODEL };
const session: AgentSession =
  kind === "claude"
    ? new ClaudeSession({ permissionMode: "default" }, init, events)
    : new CodexSession({ sandboxMode: "workspace-write", networkAccess: false }, init, events);

session.send(prompt);
await finished;
await session.close();
