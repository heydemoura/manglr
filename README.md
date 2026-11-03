# medabot-agents

A Telegram gateway for Claude Code and Codex sessions running on this host.
Each agent session lives in its own thread (forum topic) of a private Telegram
group: the agent's replies and progress show up in the thread, and your replies
in the thread become its next input.

```
General:   /new fix the login redirect
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
| reply in a thread | Goes to that session. While it works: Claude folds it into the running turn, Codex queues it for the next turn. |
| `/model` or 🧠 | Switch this thread's model from a button menu (also on the thread's first message and on `/status`). |
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

**Restarts.** The gateway only stores topic → session id (`data/sessions.json`);
the agents keep their transcripts (`~/.claude/projects`, `~/.codex/sessions`).
After a restart, the next message in a thread resumes its session.

## Security

The bot can run commands on this host. It ignores every update that isn't
from `TELEGRAM_ALLOWED_USER_IDS` inside `TELEGRAM_CHAT_ID`. Sessions start in
`AGENT_CWD` (default: your home directory); tell the agent in your message which
folder to work in. With the default permission settings Claude asks before
touching anything outside that folder; with `CLAUDE_PERMISSION_MODE=bypassPermissions`
and `CODEX_SANDBOX=danger-full-access` both agents have full access to the host,
so whoever controls your Telegram account controls this machine: turn on
Telegram's two-step verification. Keep `.env` private; anyone with the token can
impersonate the bot, not you.

## Development

```sh
npm run dev         # tsx watch
npm run typecheck   # src, tests and scripts
npm test            # formatting, chunking and /model menu tests
npm run smoke -- claude "create hello.txt containing hi"   # one turn, no Telegram
npm run smoke -- codex "what files are here?" ~/some/folder
npm run build && npm start
```

`scripts/smoke.ts` drives an agent adapter from the terminal and prints every
event: useful to check SDK behaviour without the bot. `SMOKE_RESUME=<id>`
resumes a session, `SMOKE_MODEL=<model>` picks the model, `SMOKE_PERMISSION=deny`
denies permission requests.

### Layout

```
src/index.ts              wiring, startup checks, shutdown
src/config.ts             .env
src/store.ts              topic ↔ session records (data/sessions.json)
src/sessions.ts           live sessions per topic, lazy resume, per-thread model
src/models.ts             model menu entries, read from each agent
src/agents/claude.ts      Agent SDK: streaming-input query(), canUseTool, interrupt, resume
src/agents/codex.ts       Codex SDK: thread per topic, streamed turns, abort, resume
src/telegram/bot.ts       commands, /new menu, routing, buttons
src/telegram/topic-ui.ts  per-thread UI: typing, live status message, replies
src/telegram/permissions.ts  permission prompts ↔ buttons
src/telegram/format.ts    Markdown → Telegram HTML, 4096-char chunking
```

## Not yet

- Photos and files in either direction (text only; very long replies also come as `reply.md`).
- Claude's interactive question picker (`AskUserQuestion`) is disabled; Claude asks in plain text instead.
- Approvals for Codex (would need `codex app-server` instead of the SDK).
- Running as a service (launchd / systemd unit).
