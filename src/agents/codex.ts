import path from "node:path";
import { Codex, type ModelReasoningEffort, type Thread, type ThreadEvent, type ThreadItem, type ThreadOptions } from "@openai/codex-sdk";
import type { Config } from "../config.js";
import { oneLineCommand } from "../util/command.js";
import { log } from "../util/log.js";
import type { AgentEvents, AgentSession } from "./types.js";

export interface CodexSessionInit {
  cwd: string;
  /** Resume this Codex thread instead of starting a new one. */
  resume?: string;
  /** Model for this session; undefined: Codex's default (config.toml). */
  model?: string;
  /** Reasoning effort for this session; undefined: Codex's default. */
  effort?: string;
}

/**
 * A Codex thread driven through the Codex SDK. Codex runs one turn per
 * message; messages sent while a turn runs are queued and sent together as
 * the next turn. The SDK has no approval callback, so Codex runs in the
 * configured sandbox with approvals off (`approvalPolicy: "never"`).
 */
export class CodexSession implements AgentSession {
  readonly kind = "codex" as const;
  private readonly codex: Codex;
  private thread?: Thread;
  /** Known once the first turn starts (or from `resume`). */
  private threadId?: string;
  private model?: string;
  private effort?: string;
  /** The model and effort `thread` was opened with: different ones mean reopen it. */
  private threadModel?: string;
  private threadEffort?: string;
  private abort?: AbortController;
  private queued: string[] = [];
  private running = false;
  private closed = false;
  private pendingText?: string;

  constructor(
    private readonly cfg: Config["codex"],
    private readonly init: CodexSessionInit,
    private readonly events: AgentEvents,
  ) {
    this.codex = new Codex({ codexPathOverride: cfg.executable });
    this.threadId = init.resume;
    this.model = init.model;
    this.effort = init.effort;
  }

  get busy(): boolean {
    return this.running;
  }

  send(text: string): void {
    if (this.closed) throw new Error("session is closed");
    this.queued.push(text);
    if (!this.running) void this.runNext();
  }

  async setModel(model: string | undefined): Promise<void> {
    // Each turn is a separate `codex exec`: the next getThread() resumes the
    // same thread id with the new model. The running turn keeps its model.
    this.model = model;
  }

  async setEffort(effort: string | undefined): Promise<void> {
    // Like setModel: the next turn resumes the thread with the new effort.
    this.effort = effort;
  }

  async interrupt(): Promise<void> {
    this.queued = [];
    this.abort?.abort();
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.interrupt();
  }

  private getThread(): Thread {
    if (this.thread && this.threadModel === this.model && this.threadEffort === this.effort) return this.thread;
    const options: ThreadOptions = {
      workingDirectory: this.init.cwd,
      model: this.model,
      modelReasoningEffort: this.effort as ModelReasoningEffort | undefined,
      sandboxMode: this.cfg.sandboxMode,
      networkAccessEnabled: this.cfg.networkAccess,
      approvalPolicy: "never",
      skipGitRepoCheck: true,
    };
    this.thread = this.threadId ? this.codex.resumeThread(this.threadId, options) : this.codex.startThread(options);
    this.threadModel = this.model;
    this.threadEffort = this.effort;
    return this.thread;
  }

  private async runNext(): Promise<void> {
    if (this.closed || this.queued.length === 0) return;
    const input = this.queued.splice(0).join("\n\n");
    this.running = true;
    this.pendingText = undefined;
    this.abort = new AbortController();
    this.events.turnStarted();

    let error: string | undefined;
    let interrupted = false;
    try {
      const { events } = await this.getThread().runStreamed(input, { signal: this.abort.signal });
      for await (const ev of events) {
        const failure = this.handle(ev);
        if (failure) error = failure;
      }
    } catch (err) {
      if (this.abort.signal.aborted) interrupted = true;
      else if (error) {
        // Codex reported why the turn failed (turn.failed / error), then exited 1.
        // The exit error only carries stderr ("Reading prompt from stdin..."): keep the reason.
        log.error(`codex turn failed: ${error}`);
      } else {
        log.error("codex turn failed", err);
        error = err instanceof Error ? err.message : String(err);
      }
    }

    // The turn's last agent message is its answer, unless the turn didn't finish cleanly.
    const last = this.takePendingText();
    if (last) this.events.reply(last, !error && !interrupted);
    this.running = false;
    this.abort = undefined;
    this.events.turnEnded({ error, interrupted });
    void this.runNext();
  }

  /** Returns an error message when the event ends the turn badly. */
  private handle(ev: ThreadEvent): string | undefined {
    switch (ev.type) {
      case "thread.started":
        this.threadId = ev.thread_id;
        this.events.sessionId(ev.thread_id);
        return;
      case "item.started":
        if (ev.item.type === "command_execution" || ev.item.type === "mcp_tool_call" || ev.item.type === "web_search") {
          this.flushPendingText();
          this.events.progress(describeItem(ev.item, this.init.cwd));
        }
        return;
      case "item.completed":
        this.onItemCompleted(ev.item);
        return;
      case "turn.failed":
        return ev.error.message;
      case "error":
        return ev.message;
      default:
        return;
    }
  }

  private onItemCompleted(item: ThreadItem): void {
    switch (item.type) {
      case "agent_message":
        this.flushPendingText();
        this.pendingText = item.text;
        return;
      case "file_change":
        this.flushPendingText();
        this.events.progress(describeItem(item, this.init.cwd));
        return;
      case "command_execution":
        if (item.status === "failed" || (item.exit_code !== undefined && item.exit_code !== 0)) {
          this.events.progress(`   ↳ exit ${item.exit_code ?? "?"}`);
        }
        return;
      case "error":
        this.events.progress(`⚠️ ${item.message}`);
        return;
      default:
        return;
    }
  }

  private takePendingText(): string | undefined {
    const text = this.pendingText?.trim() ? this.pendingText : undefined;
    this.pendingText = undefined;
    return text;
  }

  private flushPendingText(): void {
    const text = this.takePendingText();
    if (text) this.events.reply(text, false);
  }
}

const clip = (s: string, max = 160) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

function describeItem(item: ThreadItem, cwd: string): string {
  const rel = (p: string) => {
    const r = path.relative(cwd, p);
    return r && !r.startsWith("..") && !path.isAbsolute(r) ? r : p;
  };
  switch (item.type) {
    case "command_execution":
      return clip(`💻 ${oneLineCommand(item.command)}`);
    case "file_change":
      return clip(item.changes.map((c) => `${c.kind === "add" ? "📝" : c.kind === "delete" ? "🗑️" : "✏️"} ${rel(c.path)}`).join("\n"), 600);
    case "mcp_tool_call":
      return clip(`🔧 ${item.server}.${item.tool}`);
    case "web_search":
      return clip(`🌐 Search ${item.query}`);
    default:
      return `🔧 ${item.type}`;
  }
}
