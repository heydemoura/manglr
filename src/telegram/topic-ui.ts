import { InlineKeyboard, InputFile, type Api } from "grammy";
import type { AgentEvents, PermissionDecision, PermissionRequest } from "../agents/types.js";
import { log } from "../util/log.js";
import { chunkMarkdown, escapeHtml, markdownToHtml, TELEGRAM_LIMIT } from "./format.js";
import type { PermissionBroker } from "./permissions.js";

/** Replies longer than this also arrive as a .md file. */
const ATTACH_OVER = 12_000;
/** Progress lines kept in the status message. */
const STATUS_LINES = 15;
const EDIT_EVERY_MS = 1500;
const TYPING_EVERY_MS = 4500;

/**
 * The Telegram side of one agent session, living in one forum topic:
 * a "typing…" indicator while the agent works, one status message per turn
 * that is edited as tools run (with a Stop button), the agent's replies as
 * formatted messages, and permission prompts with buttons.
 */
export class TopicUI implements AgentEvents {
  private sendChain: Promise<unknown> = Promise.resolve();
  private typing?: NodeJS.Timeout;
  private turn?: {
    startedAt: number;
    lines: string[];
    steps: number;
    statusId?: number;
    statusPending?: Promise<void>;
    lastEdit: number;
    editTimer?: NodeJS.Timeout;
  };

  constructor(
    private readonly api: Api,
    private readonly chatId: number,
    private readonly topicId: number,
    private readonly permissions: PermissionBroker,
    private readonly onSessionId: (id: string) => void,
  ) {}

  sessionId(id: string): void {
    this.onSessionId(id);
  }

  turnStarted(): void {
    this.turn = { startedAt: Date.now(), lines: [], steps: 0, lastEdit: 0 };
    this.startTyping();
  }

  progress(line: string): void {
    const t = this.turn;
    if (!t) return;
    t.steps++;
    t.lines.push(line);
    if (t.lines.length > STATUS_LINES) t.lines.splice(0, t.lines.length - STATUS_LINES);
    this.scheduleStatus();
  }

  reply(text: string, final: boolean): void {
    this.enqueue(() => this.sendReply(text, final));
  }

  turnEnded(info: { error?: string; interrupted?: boolean; costUsd?: number }): void {
    this.stopTyping();
    const t = this.turn;
    this.turn = undefined;
    if (!t) return;
    clearTimeout(t.editTimer);
    const secs = Math.round((Date.now() - t.startedAt) / 1000);
    const elapsed = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
    const parts = [`${t.steps} step${t.steps === 1 ? "" : "s"}`, elapsed];
    if (info.costUsd) parts.push(`$${info.costUsd.toFixed(2)}`);
    const head = info.interrupted
      ? "⏹ <b>Stopped</b>"
      : info.error
        ? `❌ <b>Failed</b>: ${escapeHtml(info.error.slice(0, 500))}`
        : "✅ <b>Done</b>";
    const summary = `${head} · ${parts.join(" · ")}`;

    if (t.statusId !== undefined || t.statusPending) {
      // Final edit, after any in-flight status send.
      void (t.statusPending ?? Promise.resolve()).then(() => this.editStatus(t, summary, false));
    } else if (info.error || info.interrupted) {
      // No status message was ever needed; still say why the turn ended.
      this.enqueue(() => this.send(summary, { disable_notification: false }));
    }
  }

  askPermission(req: PermissionRequest): Promise<PermissionDecision> {
    this.stopTyping(); // waiting on the person, not working
    return this.permissions.request(this.chatId, this.topicId, req).finally(() => {
      if (this.turn) this.startTyping();
    });
  }

  /** Post a plain HTML notice in the topic (used by the bot). */
  notice(html: string): Promise<unknown> {
    return this.enqueue(() => this.send(html, { disable_notification: true }));
  }

  dispose(): void {
    this.stopTyping();
    if (this.turn) clearTimeout(this.turn.editTimer);
  }

  // --- status message -------------------------------------------------------

  private statusHtml(t: NonNullable<TopicUI["turn"]>, head: string): string {
    const body = t.lines.map(escapeHtml).join("\n");
    const html = body ? `${head}\n<blockquote expandable>${body}</blockquote>` : head;
    return html.length <= TELEGRAM_LIMIT ? html : `${head}\n<blockquote expandable>…${body.slice(-(TELEGRAM_LIMIT - head.length - 80))}</blockquote>`;
  }

  private stopKeyboard(): InlineKeyboard {
    return new InlineKeyboard().text("⏹ Stop", `stop:${this.topicId}`);
  }

  private scheduleStatus(): void {
    const t = this.turn;
    if (!t) return;
    if (t.statusId === undefined && !t.statusPending) {
      t.statusPending = this.enqueue(async () => {
        const msg = await this.api.sendMessage(this.chatId, this.statusHtml(t, "⏳ <b>Working…</b>"), {
          message_thread_id: this.topicId,
          parse_mode: "HTML",
          disable_notification: true,
          reply_markup: this.stopKeyboard(),
        });
        t.statusId = msg.message_id;
        t.lastEdit = Date.now();
      })
        .catch(() => undefined) // already logged by enqueue; the turn goes on without a status message
        .then(() => {
          t.statusPending = undefined;
        });
      return;
    }
    if (t.editTimer) return;
    const wait = Math.max(0, EDIT_EVERY_MS - (Date.now() - t.lastEdit));
    t.editTimer = setTimeout(() => {
      t.editTimer = undefined;
      if (this.turn === t) void (t.statusPending ?? Promise.resolve()).then(() => this.editStatus(t, "⏳ <b>Working…</b>", true));
    }, wait);
  }

  private async editStatus(t: NonNullable<TopicUI["turn"]>, head: string, running: boolean): Promise<void> {
    if (t.statusId === undefined) return;
    t.lastEdit = Date.now();
    try {
      await this.api.editMessageText(this.chatId, t.statusId, this.statusHtml(t, head), {
        parse_mode: "HTML",
        reply_markup: running ? this.stopKeyboard() : undefined,
      });
    } catch (err) {
      if (!String(err).includes("message is not modified")) log.debug("status edit failed", err);
    }
  }

  // --- replies --------------------------------------------------------------

  private async sendReply(text: string, final: boolean): Promise<void> {
    const opts = { disable_notification: !final };
    const chunks = chunkMarkdown(text);
    const shown = text.length > ATTACH_OVER ? chunks.slice(0, 1) : chunks;
    for (const chunk of shown) {
      const html = markdownToHtml(chunk);
      if (html.length <= TELEGRAM_LIMIT) {
        try {
          await this.send(html, opts);
          continue;
        } catch (err) {
          log.warn("HTML send failed, falling back to plain text", String(err));
        }
      }
      await this.api.sendMessage(this.chatId, chunk.slice(0, TELEGRAM_LIMIT), { message_thread_id: this.topicId, ...opts });
    }
    if (shown.length < chunks.length) {
      await this.api.sendDocument(this.chatId, new InputFile(Buffer.from(text, "utf8"), "reply.md"), {
        message_thread_id: this.topicId,
        caption: `Full reply (${chunks.length} parts)`,
        ...opts,
      });
    }
  }

  private send(html: string, opts: { disable_notification: boolean }) {
    return this.api.sendMessage(this.chatId, html, {
      message_thread_id: this.topicId,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...opts,
    });
  }

  /** Keep the topic's messages in order: everything posted goes through one chain. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.sendChain.then(fn, fn);
    this.sendChain = next.catch((err) => log.error(`telegram send failed in topic ${this.topicId}`, err));
    return next;
  }

  // --- typing indicator -----------------------------------------------------

  private startTyping(): void {
    if (this.typing) return;
    const tick = () =>
      void this.api.sendChatAction(this.chatId, "typing", { message_thread_id: this.topicId }).catch(() => undefined);
    tick();
    this.typing = setInterval(tick, TYPING_EVERY_MS);
  }

  private stopTyping(): void {
    clearInterval(this.typing);
    this.typing = undefined;
  }
}
