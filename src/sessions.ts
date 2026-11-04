import type { Api } from "grammy";
import { ClaudeSession } from "./agents/claude.js";
import { CodexSession } from "./agents/codex.js";
import type { AgentKind, AgentSession } from "./agents/types.js";
import type { Config, Project } from "./config.js";
import type { HostRegistry } from "./remote/registry.js";
import type { SessionRecord, SessionStore } from "./store.js";
import type { PermissionBroker } from "./telegram/permissions.js";
import { TopicUI } from "./telegram/topic-ui.js";
import type { SessionTopics } from "./telegram/session-topics.js";
import { log } from "./util/log.js";

interface Live {
  session: AgentSession;
  ui: TopicUI;
}

/**
 * Owns the running agent sessions, one per topic. Sessions are started
 * lazily: after a gateway restart, the first message in a topic resumes the
 * agent's saved session (Claude session id / Codex thread id) from the store.
 */
export class SessionManager {
  private readonly live = new Map<number, Live>();

  constructor(
    private readonly cfg: Config,
    private readonly api: Api,
    private readonly store: SessionStore,
    private readonly permissions: PermissionBroker,
    private readonly hosts?: HostRegistry,
    private readonly topics?: SessionTopics,
  ) {}

  create(topicId: number, agent: AgentKind, project: Project, title: string, autoTitle: boolean, host?: string): SessionRecord {
    return this.store.upsert({ topicId, agent, host, project: project.name, cwd: project.path, title, autoTitle, activity: "idle" });
  }

  initializeTopic(topicId: number): Promise<void> {
    return this.topics?.refresh(topicId) ?? Promise.resolve();
  }

  restoreTopics(): Promise<void> {
    return this.topics?.restore() ?? Promise.resolve();
  }

  isBusy(topicId: number): boolean {
    return this.live.get(topicId)?.session.busy ?? false;
  }

  send(topicId: number, text: string): void {
    const live = this.ensure(topicId);
    if (!live) throw new Error(`no open session for topic ${topicId}`);
    this.topics?.userMessage(topicId, text);
    if (live.session.busy) {
      void live.ui.notice(
        live.session.kind === "codex" ? "📥 <i>Queued: Codex will get this when the current turn ends.</i>" : "📥 <i>Sent to Claude mid-turn.</i>",
      );
    }
    try {
      live.session.send(text);
    } catch (err) {
      this.topics?.state(topicId, "idle");
      throw err;
    }
    this.store.update(topicId, {}); // bump updatedAt for /list ordering
  }

  /** Switch a session's model; `undefined` goes back to the configured default. */
  async setModel(topicId: number, model: string | undefined): Promise<void> {
    const record = this.store.update(topicId, { model });
    if (!record) throw new Error(`no session for topic ${topicId}`);
    await this.live.get(topicId)?.session.setModel(this.effectiveModel(record));
    await this.topics?.refresh(topicId);
  }

  /** Switch a session's reasoning effort; `undefined` goes back to the configured default. */
  async setEffort(topicId: number, effort: string | undefined): Promise<void> {
    const record = this.store.update(topicId, { effort });
    if (!record) throw new Error(`no session for topic ${topicId}`);
    await this.live.get(topicId)?.session.setEffort(this.effectiveEffort(record));
    await this.topics?.refresh(topicId);
  }

  async stop(topicId: number): Promise<boolean> {
    const live = this.live.get(topicId);
    if (!live?.session.busy) return false;
    await live.session.interrupt();
    return true;
  }

  async end(topicId: number): Promise<void> {
    const live = this.live.get(topicId);
    this.live.delete(topicId);
    if (live) {
      live.ui.dispose();
      await live.session.close();
    }
    this.store.update(topicId, { closed: true });
    this.topics?.state(topicId, "ended");
    await this.topics?.refresh(topicId);
  }

  async shutdown(): Promise<void> {
    await this.permissions.denyAll("⏹ Gateway shutting down");
    await Promise.all(
      [...this.live.values()].map(async ({ session, ui }) => {
        ui.dispose();
        await session.close().catch((err) => log.warn("close failed", err));
      }),
    );
    this.live.clear();
    this.hosts?.shutdown();
    await this.topics?.shutdown();
  }

  private ensure(topicId: number): Live | undefined {
    const existing = this.live.get(topicId);
    if (existing) return existing;
    const record = this.store.get(topicId);
    if (!record || record.closed) return undefined;

    const ui = new TopicUI(this.api, this.cfg.telegram.chatId!, topicId, this.permissions, (sessionId) => {
      this.store.update(topicId, { sessionId });
      void this.topics?.refresh(topicId);
    }, {
      state: (activity) => this.topics?.state(topicId, activity),
      reply: (text) => this.topics?.assistantMessage(topicId, text),
    });
    const init = { cwd: record.cwd, resume: record.sessionId, model: this.effectiveModel(record), effort: this.effectiveEffort(record) };
    let session: AgentSession;
    try {
      session = record.host
        ? this.remote(record.host).session(record.host, record.agent, init, ui)
        : record.agent === "claude"
          ? new ClaudeSession(this.cfg.claude, init, ui)
          : new CodexSession(this.cfg.codex, init, ui);
    } catch (err) {
      ui.dispose();
      throw err;
    }
    const live = { session, ui };
    this.live.set(topicId, live);
    log.info(
      `session for topic ${topicId}: ${record.agent} in ${record.cwd}` +
        (record.host ? ` on ${record.host}` : "") +
        (init.model ? ` with ${init.model}` : "") +
        (init.effort ? ` at ${init.effort} effort` : "") +
        (record.sessionId ? ` (resuming ${record.sessionId})` : ""),
    );
    return live;
  }

  private remote(host: string): HostRegistry {
    if (!this.hosts) throw new Error(`host "${host}" is not in the hosts file anymore`);
    return this.hosts;
  }

  /** The session's own pick, else the env default, else undefined (the agent's default). */
  private effectiveModel(record: SessionRecord): string | undefined {
    return record.model ?? (record.agent === "claude" ? this.cfg.claude.model : this.cfg.codex.model);
  }

  /** The session's own pick, else the env default, else undefined (the model's default). */
  private effectiveEffort(record: SessionRecord): string | undefined {
    return record.effort ?? (record.agent === "claude" ? this.cfg.claude.effort : this.cfg.codex.reasoningEffort);
  }
}
