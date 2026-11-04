import { hostname } from "node:os";
import { InlineKeyboard, type Api } from "grammy";
import { AGENTS } from "../agents/types.js";
import type { Config } from "../config.js";
import type { ModelCatalog } from "../models.js";
import type { HostDirectory } from "../remote/registry.js";
import type { SessionActivity, SessionRecord, SessionStore, TitleContext } from "../store.js";
import { cleanTitle, type TitleSummarizer } from "../topic-titles.js";
import { log } from "../util/log.js";
import { escapeHtml } from "./format.js";

export const ACTIVITY = {
  ready: { emoji: "✅", label: "ready" },
  working: { emoji: "⏳", label: "working" },
  idle: { emoji: "💤", label: "idle" },
  ended: { emoji: "⏹", label: "ended" },
} satisfies Record<SessionActivity, { emoji: string; label: string }>;

export function activityOf(record: SessionRecord): SessionActivity {
  return record.closed ? "ended" : record.activity ?? "idle";
}

export function topicName(title: string, activity: SessionActivity = "idle"): string {
  return `${ACTIVITY[activity].emoji} ${title}`.slice(0, 128);
}

/** Owns each topic's name and durable pinned session card. */
export class SessionTopics {
  private readonly updates = new Map<number, Promise<void>>();
  private readonly names = new Map<number, string>();
  private readonly cards = new Map<number, { id: number; html: string }>();
  private readonly timers = new Map<number, NodeJS.Timeout>();
  private readonly summaries = new Map<number, AbortController>();
  private summaryChain: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly cfg: Config,
    private readonly api: Api,
    private readonly store: SessionStore,
    private readonly models: Pick<ModelCatalog, "label" | "effortLabel">,
    private readonly summarize: TitleSummarizer,
    private readonly hosts?: HostDirectory,
    private readonly summaryDelay = 1000,
  ) {}

  userMessage(topicId: number, text: string): void {
    const record = this.store.get(topicId);
    if (!record || record.closed || this.disposed) return;
    const fallback = record.autoTitle ? cleanTitle(text.split("\n")[0]!) || record.title : record.title;
    this.store.update(topicId, { title: fallback, autoTitle: false });
    this.addContext(topicId, "user", text);
    void this.refresh(topicId);
  }

  assistantMessage(topicId: number, text: string): void {
    this.addContext(topicId, "assistant", text);
  }

  state(topicId: number, activity: SessionActivity): void {
    const record = this.store.get(topicId);
    if (!record || this.disposed || (record.closed && activity !== "ended")) return;
    this.store.update(topicId, { activity });
    if (activity === "ended") this.cancelSummary(topicId);
    void this.refresh(topicId);
  }

  /** Serializing edits prevents a slow old update from overwriting a newer state. */
  refresh(topicId: number): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const next = (this.updates.get(topicId) ?? Promise.resolve()).then(() => this.render(topicId))
      .catch(() => log.warn(`topic ${topicId}: could not update its title or session card`));
    this.updates.set(topicId, next);
    void next.then(() => { if (this.updates.get(topicId) === next) this.updates.delete(topicId); });
    return next;
  }

  /** Recover existing topics without claiming an old turn is still running. */
  async restore(): Promise<void> {
    const records = this.store.list().filter((record) => !record.closed);
    // Reset before any network waits: a prompt received during restoration starts real new work.
    for (const record of records) {
      if (record.activity === "working") this.store.update(record.topicId, { activity: "idle" });
    }
    for (const record of records) {
      if (this.disposed) return;
      await this.refresh(record.topicId);
    }
  }

  async shutdown(): Promise<void> {
    this.disposed = true;
    for (const id of this.timers.keys()) this.cancelSummary(id);
    for (const controller of this.summaries.values()) controller.abort();
    await Promise.all(this.updates.values());
    await this.summaryChain;
  }

  private addContext(topicId: number, role: TitleContext["role"], text: string): void {
    const record = this.store.get(topicId);
    if (!record || record.closed || this.disposed || !text.trim()) return;
    const all = [...(record.titleContext ?? []), { role, text: text.slice(0, 1800) }];
    // Keep the original goal plus recent discussion, bounded independently of transcript size.
    const titleContext = all.length <= 8 ? all : [all[0]!, ...all.slice(-7)];
    this.store.update(topicId, { titleContext });
    this.cancelSummary(topicId);
    const timer = setTimeout(() => {
      this.timers.delete(topicId);
      const run = this.summaryChain.then(() => this.updateSummary(topicId, titleContext));
      this.summaryChain = run.catch(() => log.debug(`topic ${topicId}: title summary unavailable; keeping its current title`));
    }, this.summaryDelay);
    timer.unref();
    this.timers.set(topicId, timer);
  }

  private cancelSummary(topicId: number): void {
    clearTimeout(this.timers.get(topicId));
    this.timers.delete(topicId);
    this.summaries.get(topicId)?.abort();
  }

  private async updateSummary(topicId: number, context: TitleContext[]): Promise<void> {
    const record = this.store.get(topicId);
    if (this.disposed || !record || record.closed || record.titleContext !== context) return;
    const controller = new AbortController();
    this.summaries.set(topicId, controller);
    try {
      const title = cleanTitle(await this.summarize(record.title, context, controller.signal));
      if (this.disposed || controller.signal.aborted || this.store.get(topicId)?.closed || this.store.get(topicId)?.titleContext !== context || !title) return;
      // Patch only the title: inference may finish while a new working/idle state is being rendered.
      this.store.update(topicId, { title });
      await this.refresh(topicId);
    } finally {
      if (this.summaries.get(topicId) === controller) this.summaries.delete(topicId);
    }
  }

  private async render(topicId: number): Promise<void> {
    if (this.disposed) return;
    let record = this.store.get(topicId);
    if (!record) return;
    let catalog: Pick<ModelCatalog, "label" | "effortLabel"> | undefined = this.models;
    if (record.host) {
      try { catalog = this.hosts?.catalog(record.host); } catch { catalog = undefined; }
    }
    const [model, effort] = catalog
      ? await Promise.all([catalog.label(record.agent, record.model), catalog.effortLabel(record.agent, record.model, record.effort)])
      : [record.model ?? "Default", record.effort ?? "Default"];
    record = this.store.get(topicId)!; // state or title may have changed while the catalog loaded
    if (this.disposed) return;
    const state = ACTIVITY[activityOf(record)];
    const name = topicName(record.title, activityOf(record));
    if (this.names.get(topicId) !== name) {
      try {
        await this.api.editForumTopic(this.cfg.telegram.chatId!, topicId, { name });
        this.names.set(topicId, name);
      } catch {
        log.warn(`topic ${topicId}: could not rename the topic`);
      }
    }
    const host = record.host ?? (hostname().split(".")[0] || "local");
    const mode = record.agent === "claude"
      ? this.cfg.claude.permissionMode === "bypassPermissions" ? "⚠️ full host access, no approval prompts" : `permissions: ${this.cfg.claude.permissionMode}, asks here when needed`
      : this.cfg.codex.sandboxMode === "danger-full-access" ? "⚠️ full host access, no sandbox" : `sandbox: ${this.cfg.codex.sandboxMode}, network ${this.cfg.codex.networkAccess ? "on" : "off"}`;
    const html = [
      `<b>${escapeHtml(record.title)}</b>`,
      `Agent: <b>${AGENTS[record.agent].label}</b>`,
      `Host: <b>${escapeHtml(host)}</b> (${record.host ? "remote" : "local"})`,
      `Folder: <code>${escapeHtml(record.cwd)}</code>`,
      `🧠 ${escapeHtml(model)} <i>(/model to switch)</i>`,
      `⚡ ${escapeHtml(effort)} effort <i>(/effort to switch)</i>`,
      `State: ${state.emoji} ${state.label}`,
      `Session: <code>${escapeHtml(record.sessionId ?? "not started")}</code>`,
      `<i>${escapeHtml(mode)}</i>`,
      ...(!record.sessionId && !record.closed ? ["Send a message to start."] : []),
    ].join("\n");
    const opts = { parse_mode: "HTML" as const, reply_markup: record.closed ? undefined : new InlineKeyboard().text("🧠 Change model", "mdl:o").text("⚡ Change effort", "eff:o") };
    let messageId = record.pinnedMessageId;
    const cached = this.cards.get(topicId);
    if (messageId !== undefined && (cached?.id !== messageId || cached.html !== html)) {
      try {
        await this.api.editMessageText(this.cfg.telegram.chatId!, messageId, html, opts);
      } catch (err) {
        if (!/message is not modified/i.test(String(err))) {
          if (!/message to edit not found|message can't be edited/i.test(String(err))) throw err;
          messageId = undefined;
        }
      }
    }
    if (messageId === undefined) {
      const message = await this.api.sendMessage(this.cfg.telegram.chatId!, html, { ...opts, message_thread_id: topicId, disable_notification: true });
      messageId = message.message_id;
      this.store.update(topicId, { pinnedMessageId: messageId, cardPinned: false });
    }
    this.cards.set(topicId, { id: messageId, html });
    if (!this.store.get(topicId)?.cardPinned) {
      try {
        await this.api.pinChatMessage(this.cfg.telegram.chatId!, messageId, { disable_notification: true });
        this.store.update(topicId, { cardPinned: true });
      } catch {
        log.warn(`topic ${topicId}: could not pin the session card; the bot needs Pin Messages permission`);
      }
    }
  }
}
