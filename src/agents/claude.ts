import path from "node:path";
import {
  query,
  type CanUseTool,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../config.js";
import { AsyncQueue } from "../util/async-queue.js";
import { oneLineCommand } from "../util/command.js";
import { log } from "../util/log.js";
import type { AgentEvents, AgentSession } from "./types.js";

export interface ClaudeSessionInit {
  cwd: string;
  /** Resume this Claude Code session instead of starting a new one. */
  resume?: string;
  /** Model for this session; undefined: Claude Code's default. */
  model?: string;
}

/**
 * A long-lived Claude Code session driven through the Agent SDK in streaming
 * input mode: one `query()` per session, fed by a queue of user messages.
 * Messages sent mid-turn are queued and folded in by Claude Code itself.
 * If the underlying process ends (crash, close), the next `send()` starts a
 * new `query()` that resumes the same session id.
 */
export class ClaudeSession implements AgentSession {
  readonly kind = "claude" as const;
  private q?: Query;
  private input?: AsyncQueue<SDKUserMessage>;
  private sessionId?: string;
  private running = false;
  private interrupted = false;
  private closed = false;
  /** Latest assistant text this turn: intermediate if a tool call follows, else it is the final answer. */
  private pendingText?: string;
  private model?: string;

  constructor(
    private readonly cfg: Config["claude"],
    private readonly init: ClaudeSessionInit,
    private readonly events: AgentEvents,
  ) {
    this.sessionId = init.resume;
    this.model = init.model;
  }

  get busy(): boolean {
    return this.running;
  }

  send(text: string): void {
    if (this.closed) throw new Error("session is closed");
    if (!this.q || !this.input || this.input.isEnded) this.start();
    if (!this.running) this.beginTurn();
    this.input!.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      origin: { kind: "human" },
    });
  }

  async setModel(model: string | undefined): Promise<void> {
    this.model = model;
    // A running process switches in place; otherwise the next start() picks it up.
    if (this.q) await this.q.setModel(model);
  }

  async interrupt(): Promise<void> {
    if (!this.q || !this.running) return;
    this.interrupted = true;
    await this.q.interrupt();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.input?.end();
    this.q?.close();
    this.q = undefined;
  }

  private start(): void {
    this.input = new AsyncQueue<SDKUserMessage>();
    const options: Options = {
      cwd: this.init.cwd,
      resume: this.sessionId,
      model: this.model,
      effort: this.cfg.effort,
      permissionMode: this.cfg.permissionMode,
      allowDangerouslySkipPermissions: this.cfg.permissionMode === "bypassPermissions" || undefined,
      pathToClaudeCodeExecutable: this.cfg.executable,
      // The Claude Code system prompt plus a note about where replies end up.
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append:
          "You are being driven from a Telegram chat. The person reads your replies on a phone: " +
          "keep them concise, prefer short paragraphs and lists, and ask questions in plain text.",
      },
      // Questions come back as plain text the person can reply to in the thread;
      // the interactive question picker has no Telegram equivalent yet.
      disallowedTools: ["AskUserQuestion"],
      canUseTool: this.canUseTool,
      stderr: (data) => log.debug(`[claude stderr] ${data.trimEnd()}`),
    };
    this.q = query({ prompt: this.input, options });
    void this.pump(this.q);
  }

  private beginTurn(): void {
    this.running = true;
    this.interrupted = false;
    this.pendingText = undefined;
    this.events.turnStarted();
  }

  private endTurn(info: { error?: string; costUsd?: number }): void {
    if (!this.running) return;
    this.running = false;
    this.events.turnEnded({ ...info, interrupted: this.interrupted });
    this.interrupted = false;
  }

  private async pump(q: Query): Promise<void> {
    try {
      for await (const msg of q) this.handle(msg);
      this.endTurn({ error: this.closed ? undefined : "Claude Code exited" });
    } catch (err) {
      log.error("claude query failed", err);
      this.endTurn({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      if (this.q === q) {
        this.input?.end();
        this.q = undefined; // the next send() resumes in a fresh process
      }
    }
  }

  private handle(msg: SDKMessage): void {
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init" && msg.session_id !== this.sessionId) {
          this.sessionId = msg.session_id;
          this.events.sessionId(msg.session_id);
        }
        return;
      case "assistant": {
        if (msg.parent_tool_use_id) return; // subagent traffic: the Agent tool line covers it
        if (!this.running) this.beginTurn(); // a queued message started a new turn
        for (const block of msg.message.content) {
          if (block.type === "tool_use") {
            this.flushPendingText();
            this.events.progress(describeTool(block.name, block.input as Record<string, unknown>, this.init.cwd));
          } else if (block.type === "text" && block.text.trim()) {
            this.flushPendingText();
            this.pendingText = block.text;
          }
        }
        return;
      }
      case "result":
        if (msg.subtype === "success") {
          const final = msg.result.trim() ? msg.result : this.pendingText;
          this.pendingText = undefined;
          if (final?.trim()) this.events.reply(final, true);
          this.endTurn({ costUsd: msg.total_cost_usd, error: msg.is_error ? "Claude reported an error" : undefined });
        } else {
          this.flushPendingText();
          const detail = "errors" in msg && Array.isArray(msg.errors) && msg.errors.length ? `: ${msg.errors.join("; ")}` : "";
          this.endTurn({ costUsd: msg.total_cost_usd, error: this.interrupted ? undefined : `${msg.subtype}${detail}` });
        }
        return;
      default:
        return;
    }
  }

  private flushPendingText(): void {
    if (this.pendingText) this.events.reply(this.pendingText, false);
    this.pendingText = undefined;
  }

  private canUseTool: CanUseTool = async (toolName, input, { signal, suggestions, decisionReason, blockedPath }) => {
    const decision = await this.events.askPermission({
      tool: toolName,
      summary: describeTool(toolName, input, this.init.cwd, 600),
      reason: blockedPath ? `Outside the project: ${blockedPath}` : decisionReason,
      canAlwaysAllow: Boolean(suggestions?.length),
      signal,
    });
    if (decision === "deny") {
      return { behavior: "deny", message: "The user denied this from Telegram." };
    }
    return {
      behavior: "allow",
      updatedInput: input,
      updatedPermissions: decision === "always" ? suggestions : undefined,
    };
  };
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** One line per tool call, as the person would want to skim it. */
export function describeTool(name: string, input: Record<string, unknown>, cwd: string, max = 160): string {
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  const file = (k: string) => {
    const p = str(k);
    if (!p) return "";
    const rel = path.relative(cwd, p);
    return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : p;
  };
  switch (name) {
    case "Bash":
      return clip(`💻 ${oneLineCommand(str("command"))}`, max);
    case "Read":
      return clip(`📖 Read ${file("file_path")}`, max);
    case "Edit":
    case "MultiEdit":
      return clip(`✏️ Edit ${file("file_path")}`, max);
    case "Write":
      return clip(`📝 Write ${file("file_path")}`, max);
    case "NotebookEdit":
      return clip(`📓 Edit ${file("notebook_path")}`, max);
    case "Glob":
      return clip(`🔎 Glob ${str("pattern")}`, max);
    case "Grep":
      return clip(`🔎 Grep ${str("pattern")}`, max);
    case "WebFetch":
      return clip(`🌐 Fetch ${str("url")}`, max);
    case "WebSearch":
      return clip(`🌐 Search ${str("query")}`, max);
    case "Agent":
    case "Task":
      return clip(`🤖 Agent: ${str("description")}`, max);
    case "TodoWrite":
      return "🗒️ Update todo list";
    default:
      return clip(`🔧 ${name}`, max);
  }
}
