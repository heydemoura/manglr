# manglr

A Telegram gateway for Claude Code and Codex sessions running on this host,
or on [other computers](#other-computers) over SSH.
Each agent session lives in its own thread (forum topic) of a private Telegram
group: the agent's replies and progress show up in the thread, and your replies
in the thread become its next input.

```
General:   fix the login redirect          (or /new fix the login redirect)
           → [🟠 Claude] [🟢 Codex] → new thread "🟠 fix the login redirect"
Thread:    ⏳ Working…  (edited live: 💻 npm test · ✏️ Edit src/auth.ts …)  [⏹ Stop]
           🔐 Bash needs permission  `git push`   [Allow] [Always allow] [Deny]
           💬 the agent's answer
           ✅ Done · 14 steps · 2m 3s · $0.41
you:       now add a test for it   ← goes to the same session
you:       /model  → [✓ Default] [Opus 5.5] [Sonnet 5.5] [Haiku 5.5] …   ← per thread
```

No terminal multiplexer and no wrapper: the gateway drives the agents through
their SDKs ([Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk),
[Codex SDK](https://github.com/openai/codex/tree/main/sdk/typescript)) using
your existing `claude` and `codex` logins on this host.

## Setup

1. **Bot**: talk to [@BotFather](https://t.me/BotFather), `/newbot`, keep the token.
2. **Group**: create a Telegram group with just you, open its settings and turn on
   **Topics**. Add the bot and make it an **admin** with *Manage topics* (admins
   receive every message, so privacy mode doesn't matter).
3. **Config**:
   ```sh
   npm install
   cp .env.example .env              # put the bot token in TELEGRAM_BOT_TOKEN
   npm run dev
   ```
   With no chat id or users configured the bot runs in **setup mode**: send
   `/whoami` in the group, put the chat id and your user id into `.env`
   (`TELEGRAM_CHAT_ID`, `TELEGRAM_ALLOWED_USER_IDS`) and restart.
4. In the group's General thread, send `/new`.

Requirements: Node 22+, a logged-in Claude Code (`claude`) and Codex (`codex login`).

## Using it

| | |
|---|---|
| `/new [task]` | Pick the agent; opens a thread. With a task it starts right away, otherwise the first message in the thread starts it (and names the thread). |
| message in General | Same as `/new <message>`: the message is kept as the task, you pick the computer and agent, and the new thread starts with it as the first prompt. Replying `/new` to any message does the same with that message. |
| reply in a thread | Goes to that session. While it works: Claude folds it into the running turn, Codex queues it for the next turn. |
| voice message | Transcribed with local Whisper on the gateway and sent as a prompt to the thread's agent. In General, opens the new-session picker with the transcript as its task. Reply `/new` to a voice message to use it as a new task. |
| `/model` or 🧠 | New threads use each agent's default model on this host. Switch a thread's model from a button menu (also on `/status`). |
| `/effort` or ⚡ | Switch a thread's reasoning effort from a button menu (also on `/status`). Only the levels the thread's model accepts are offered. |
| `/stop` or ⏹ | Interrupts the running turn; the session continues with your next message. |
| `/end` | Ends the session and closes the thread. The transcript stays on disk. |
| `/status` | Agent, folder, session id, model, permission/sandbox mode. |
| `/list` | Open sessions with links. |

**Permissions.** Claude runs with `CLAUDE_PERMISSION_MODE` (default `default`)
and your usual Claude Code settings (allow rules, CLAUDE.md, hooks, MCP). Anything
it would prompt for in the terminal arrives as a message with Allow / Always
allow / Deny. Codex's SDK has no approval callback, so Codex runs in
`CODEX_SANDBOX` (default `workspace-write`, network off) without prompts.

**Models.** Each thread has its own model, kept across restarts. The menu
lists what the agents themselves offer: Claude Code's `supportedModels()` (the
same list as its `/model`) and the models the Codex CLI caches in
`~/.codex/models_cache.json`. *Default* is `CLAUDE_MODEL` / `CODEX_MODEL` when
set, else the agent's own default. Claude switches in place, from its next
response (also mid-turn); Codex resumes the same thread with the new model on
its next turn. The conversation carries over either way.

**Effort.** Each thread also has its own reasoning effort, kept across restarts.
*Default* is `CLAUDE_EFFORT` / `CODEX_REASONING_EFFORT` when set, else the
agent's own default (for Codex, `model_reasoning_effort` in its config.toml).
The menu lists the levels the thread's model reports (Claude Code's
`supportedEffortLevels`, Codex's `supported_reasoning_levels`). Claude switches
from its next response, Codex from its next turn. Switching to a model that
lacks the thread's effort puts it back on *Default*.

**Restarts.** The gateway only stores topic → session id (`data/sessions.json`);
the agents keep their transcripts (`~/.claude/projects`, `~/.codex/sessions`).
After a restart, the next message in a thread resumes its session.

**Voice prompts.** Transcription runs locally on the gateway with
[whisper.cpp](https://github.com/ggml-org/whisper.cpp). Install its `whisper-cli`
binary and FFmpeg, then download a multilingual GGML Whisper model. On macOS:

```sh
brew install whisper.cpp ffmpeg
mkdir -p ~/.cache/manglr
curl --fail --location --output ~/.cache/manglr/ggml-small.bin.part \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin
mv ~/.cache/manglr/ggml-small.bin.part ~/.cache/manglr/ggml-small.bin
```

The default model is multilingual `small` (about 466 MiB), with automatic language
detection. To use another GGML model, set `WHISPER_MODEL_PATH` in `.env`.
`WHISPER_PATH` and `FFMPEG_PATH` override the executable paths when they aren't
on the gateway's `PATH`. Linux hosts can build whisper.cpp following its README
and install FFmpeg through their package manager. No API key or transcription
service is required. Model downloads happen during setup, never during a request.

Send a Telegram voice note: manglr shows “Transcribing…”, replaces it with a
transcript preview, and passes the full text in its original language through the
same session flow as a typed message. Voice notes can be up to 20 MB. Manglr
downloads the recording from Telegram, converts it to mono 16 kHz WAV with
FFmpeg, and runs Whisper on this host. Temporary audio and transcript files live
in a private directory and are deleted after success or failure. Audio is never
uploaded to a transcription service. For remote agent sessions, only the prompt
text is forwarded. Missing dependencies, failed transcription, or unrecognized
speech produce an explanation in Telegram and never start an agent turn; text
prompts keep working. Decoding is limited to one minute and inference to five
minutes per recording.

## Other computers

The gateway can also run agents on other computers. With a hosts file,
`/new` first asks which computer, and the thread's agent runs there: with that
computer's files, its `claude` / `codex` logins and settings. Thread names
start with the host (`🟠 bazzite: fix the tests`) and `/status` shows it.

```
Telegram ⇄ gateway ──ssh──▶ runner on bazzite ──▶ Claude / Codex
                    └─ssh──▶ runner on debian  ──▶ …
```

The gateway starts a small **runner** on each host over SSH (`node
dist/runner.js`) and talks to it on stdin/stdout: no open ports, no extra
credentials beyond your SSH key. One connection per host, opened on first use
and shared by its sessions. Permission buttons, live progress, `/model`,
`/effort` and `/stop` work the same; the model menus list what that host's
agents offer.

**Each host needs:** key-based SSH from the gateway (no password prompt; the
gateway uses `BatchMode`), Node 22+, a logged-in `claude` and/or `codex`, and
manglr built where the runner command expects it:

```sh
# on the host
git clone git@github.com:heydemoura/manglr.git ~/manglr
cd ~/manglr && npm ci && npm run build
```

**On the gateway**, list the hosts in `hosts.json` (`HOSTS_FILE`):

```json
[
  { "name": "bazzite", "ssh": "bazzite@192.168.0.146" },
  { "name": "debian", "ssh": "debian", "cwd": "~/Code" }
]
```

| field | |
|---|---|
| `name` | Shown in Telegram and stored with each session (letters, digits, `.` `_` `-`). |
| `ssh` | SSH destination: `user@host` or an alias from `~/.ssh/config`. Default: `name`. |
| `cwd` | Where sessions start on that host; `~` is the remote home. Default `~`. |
| `command` | Starts the runner. Default `cd ~/manglr && exec node dist/runner.js`. Override it when node isn't on the non-interactive SSH `PATH` (nvm, Homebrew), e.g. `"bash -lc 'cd ~/manglr && exec node dist/runner.js'"`. |
| `claudePath`, `codexPath` | Agent binaries on that host, when the SDKs shouldn't pick their own. |

Check a host without Telegram: `SMOKE_HOST=bazzite npm run smoke -- claude "say hi"`.

**When the connection drops** (host asleep, network), a running turn ends
with an error in its thread. The next message reconnects and resumes the
session from the transcript on that host. The runner ends its sessions when
the gateway disconnects, so a turn doesn't survive a dropped link.

The permission and sandbox settings (`CLAUDE_PERMISSION_MODE`,
`CODEX_SANDBOX`, …) and default model/effort come from the gateway's `.env`
and apply on every host. Keep runner and gateway on the same manglr version:
the handshake refuses a protocol mismatch.

## Security

The bot can run commands on this host. It ignores every update that isn't
from `TELEGRAM_ALLOWED_USER_IDS` inside `TELEGRAM_CHAT_ID`. Sessions start in
`AGENT_CWD` (default: your home directory); tell the agent in your message which
folder to work in. With the default permission settings Claude asks before
touching anything outside that folder; with `CLAUDE_PERMISSION_MODE=bypassPermissions`
and `CODEX_SANDBOX=danger-full-access` both agents have full access to the host,
so whoever controls your Telegram account controls this machine (and every
host in the hosts file, with the gateway's SSH key): turn on
Telegram's two-step verification. Keep `.env` private; anyone with the token can
impersonate the bot, not you.

## Development

```sh
npm run dev         # tsx watch
npm run typecheck   # src, tests and scripts
npm test            # formatting, menus, voice routing and local transcription
npm run smoke -- claude "create hello.txt containing hi"   # one turn, no Telegram
npm run smoke -- codex "what files are here?" ~/some/folder
npm run build && npm start
```

`scripts/smoke.ts` drives an agent adapter from the terminal and prints every
event: useful to check SDK behaviour without the bot. `SMOKE_RESUME=<id>`
resumes a session, `SMOKE_MODEL=<model>` picks the model, `SMOKE_EFFORT=<level>` the effort, `SMOKE_PERMISSION=deny`
denies permission requests.

### Layout

```
src/index.ts              wiring, startup checks, shutdown
src/config.ts             .env
src/store.ts              topic ↔ session records (data/sessions.json)
src/sessions.ts           live sessions per topic, lazy resume, per-thread model
src/models.ts             model menu entries, read from each agent
src/hosts.ts              hosts file (remote computers)
src/runner.ts             runner entry point: started over SSH on a remote host
src/remote/protocol.ts    hub ⇄ runner messages (JSON lines)
src/remote/host.ts        hub side: SSH connection per host, RemoteSession
src/remote/runner-core.ts runner side: hosts the agent sessions, relays events
src/remote/registry.ts    configured hosts, their sessions and model menus
src/agents/claude.ts      Agent SDK: streaming-input query(), canUseTool, interrupt, resume
src/agents/codex.ts       Codex SDK: thread per topic, streamed turns, abort, resume
src/telegram/bot.ts       commands, /new menu, routing, buttons
src/telegram/voice.ts     Telegram voice downloads → local transcription
src/telegram/local-whisper.ts  FFmpeg conversion, whisper.cpp, temporary file cleanup
src/telegram/topic-ui.ts  per-thread UI: typing, live status message, replies
src/telegram/permissions.ts  permission prompts ↔ buttons
src/telegram/format.ts    Markdown → Telegram HTML, 4096-char chunking
```

## Not yet

- Photos and files in either direction (text and incoming voice notes only; very long replies also come as `reply.md`).
- Claude's interactive question picker (`AskUserQuestion`) is disabled; Claude asks in plain text instead.
- Approvals for Codex (would need `codex app-server` instead of the SDK).
- Running as a service (launchd / systemd unit).
- Remote turns that survive a dropped SSH connection (would need the runner as a long-lived service).
