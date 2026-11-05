import { randomBytes } from "node:crypto";
import { InlineKeyboard, type Api } from "grammy";
import type { PermissionDecision, PermissionRequest } from "../agents/types.js";
import { log } from "../util/log.js";
import { codeBlock, escapeHtml } from "./format.js";

interface Pending {
  chatId: number;
  messageId: number;
  /** The request as shown, so the outcome is appended rather than replacing it. */
  body: string;
  resolve: (d: PermissionDecision) => void;
}

const LABEL: Record<PermissionDecision, string> = {
  allow: "✅ Allowed",
  always: "✅ Always allowed",
  deny: "🚫 Denied",
};

/**
 * Turns agent permission requests into Telegram messages with buttons and
 * waits for the tap. Callback data: `perm:<id>:<allow|always|deny>`.
 */
export class PermissionBroker {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly api: Api) {}

  async request(chatId: number, topicId: number, req: PermissionRequest): Promise<PermissionDecision> {
    if (req.signal.aborted) return "deny";
    const id = randomBytes(6).toString("base64url");
    const header = `🔐 <b>${escapeHtml(req.tool)}</b> needs permission`;
    const lines = [header, codeBlock(req.summary)];
    if (req.reason) lines.push(`<i>${escapeHtml(req.reason)}</i>`);
    const keyboard = new InlineKeyboard().text("Allow", `perm:${id}:allow`);
    if (req.canAlwaysAllow) keyboard.text("Always allow", `perm:${id}:always`);
    keyboard.text("Deny", `perm:${id}:deny`);

    const body = lines.join("\n");
    const msg = await this.api.sendMessage(chatId, body, {
      message_thread_id: topicId,
      parse_mode: "HTML",
      reply_markup: keyboard,
    });

    return new Promise<PermissionDecision>((resolve) => {
      this.pending.set(id, { chatId, messageId: msg.message_id, body, resolve });
      req.signal.addEventListener(
        "abort",
        () => void this.settle(id, "deny", "⏹ Cancelled (turn stopped)"),
        { once: true },
      );
    });
  }

  /**
   * Handle a button tap. Returns false when the request is gone (already
   * answered or stale). Synchronous on purpose: Telegram only accepts the tap's
   * answerCallbackQuery for a short while, so the caller answers it right away
   * and the "✅ Allowed" edit of the message (which can wait out a rate limit)
   * happens in the background.
   */
  answer(data: string): boolean {
    const [, id, decision] = data.split(":");
    if (!id || !(decision === "allow" || decision === "always" || decision === "deny")) return false;
    return this.settle(id, decision) !== undefined;
  }

  /** Deny everything still waiting (used on shutdown), and wait for the messages to say so. */
  async denyAll(note: string): Promise<void> {
    await Promise.all([...this.pending.keys()].map((id) => this.settle(id, "deny", note)));
  }

  /** Resolves the request now; returns the edit of its message, or undefined when it's gone. */
  private settle(id: string, decision: PermissionDecision, note?: string): Promise<void> | undefined {
    const p = this.pending.get(id);
    if (!p) return undefined;
    this.pending.delete(id);
    p.resolve(decision);
    return this.api
      .editMessageText(p.chatId, p.messageId, `${p.body}\n\n${note ?? LABEL[decision]}`, { parse_mode: "HTML" })
      .then(
        () => undefined,
        (err) => log.debug("could not edit permission message", err),
      );
  }
}
