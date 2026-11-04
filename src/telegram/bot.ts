import { hostname } from "node:os";
import { Bot, InlineKeyboard, type Context } from "grammy";
import type { Voice } from "grammy/types";
import { AGENTS, type AgentKind } from "../agents/types.js";
import type { Config, Project } from "../config.js";
import type { ModelCatalog } from "../models.js";
import type { HostDirectory } from "../remote/registry.js";
import type { SessionManager } from "../sessions.js";
import type { SessionRecord, SessionStore } from "../store.js";
import { log } from "../util/log.js";
import { escapeHtml } from "./format.js";
import type { PermissionBroker } from "./permissions.js";
import { createVoiceTranscriber, VoiceError, type VoiceTranscriber } from "./voice.js";
import { ACTIVITY, activityOf, topicName } from "./session-topics.js";

export const COMMANDS = [
  { command: "new", description: "Start an agent session in a new thread" },
  { command: "list", description: "Open sessions" },
  { command: "model", description: "Switch this thread's model" },
  { command: "effort", description: "Switch this thread's reasoning effort" },
  { command: "stop", description: "Stop the running turn (in a thread)" },
  { command: "end", description: "End this thread's session" },
  { command: "status", description: "Session details (in a thread)" },
  { command: "help", description: "How this works" },
];

interface Wizard {
  task?: string;
  /** Remote host picked; unset: this one. */
  host?: string;
  agent?: AgentKind;
  userId: number;
}

/** Unfinished /new menus kept at once; the oldest is dropped past this. */
const MAX_WIZARDS = 50;

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const firstLine = (s: string) => s.trim().split("\n")[0]!.trim();

/** The forum topic a message belongs to, or undefined for General / non-topic chats. */
const topicOf = (ctx: Context): number | undefined => {
  const msg = ctx.msg ?? ctx.callbackQuery?.message;
  return msg && "is_topic_message" in msg && msg.is_topic_message ? msg.message_thread_id : undefined;
};

export function registerHandlers(
  bot: Bot,
  cfg: Config,
  store: SessionStore,
  manager: SessionManager,
  permissions: PermissionBroker,
  models: ModelCatalog,
  hosts?: HostDirectory,
  transcribeVoice: VoiceTranscriber = createVoiceTranscriber(cfg, bot.api),
): void {
  const chatId = cfg.telegram.chatId;
  const remoteHosts = hosts?.names() ?? [];
  const localName = hostname().split(".")[0] || "local";
  /** The model menu of the host a session runs on. */
  const catalog = (host: string | undefined) => (host && hosts ? hosts.catalog(host) : models);
  const hostLabel = (host: string | undefined) => host ?? localName;
  const wizards = new Map<number, Wizard>();
  const claudeBypass = cfg.claude.permissionMode === "bypassPermissions";
  const codexFull = cfg.codex.sandboxMode === "danger-full-access";
  const topicLink = (topicId: number) => `https://t.me/c/${String(chatId).replace(/^-100/, "")}/${topicId}`;

  // --- setup helper, before the auth gate --------------------------------------
  bot.command("whoami", async (ctx) => {
    if (!cfg.setupMode && !cfg.telegram.allowedUserIds.has(ctx.from?.id ?? 0)) return;
    await ctx.reply(
      `chat id: <code>${ctx.chat.id}</code>\nyour user id: <code>${ctx.from?.id}</code>\nchat type: ${ctx.chat.type}` +
        ("is_forum" in ctx.chat && ctx.chat.is_forum ? " (topics on)" : ""),
      { parse_mode: "HTML", message_thread_id: topicOf(ctx) },
    );
  });

  // --- auth gate: only the configured group, only allowed users ---------------
  bot.use(async (ctx, next) => {
    if (cfg.setupMode) return;
    const uid = ctx.from?.id;
    if (uid === ctx.me.id) return; // service messages about our own topic edits
    if (!uid || !cfg.telegram.allowedUserIds.has(uid)) {
      log.warn(`ignored update from user ${uid ?? "?"} in chat ${ctx.chat?.id ?? "?"}`);
      return;
    }
    if (ctx.chat && ctx.chat.id !== chatId) {
      if (ctx.chat.type === "private") await ctx.reply("I work in the configured group. Use /new there.");
      return;
    }
    await next();
  });

  // --- commands -----------------------------------------------------------------
  bot.command(["help", "start"], (ctx) =>
    ctx.reply(
      [
        "<b>Agent gateway</b>",
        remoteHosts.length
          ? "• /new [task]: pick the computer, then Claude or Codex; a new thread opens for the session."
          : "• /new [task]: pick Claude or Codex; a new thread opens for the session.",
        "• Or just send the task in General (or reply /new to a message): it becomes the new session's first prompt.",
        "• Reply in a thread to talk to its agent. Messages sent while it works are passed along.",
        "• Voice messages are transcribed by local Whisper on the gateway and become prompts.",
        "• Topic names summarize the conversation: 💤 idle, ⏳ working, ✅ ready. The pinned card identifies the host and agent.",
        "• Tool permission requests (Claude) show up with Allow / Deny buttons.",
        "• /model switches the model of a thread's session, /effort its reasoning effort.",
        "• /stop stops the current turn, /end ends the session, /status shows details, /list lists sessions.",
      ].join("\n"),
      { parse_mode: "HTML", message_thread_id: topicOf(ctx) },
    ),
  );

  const newPrompt = (task: string | undefined, question: string) =>
    task ? `New session for:\n<i>${escapeHtml(clip(task, 300))}</i>\n\n${question}` : `New session. ${question}`;

  function agentKeyboard(): InlineKeyboard {
    const keyboard = new InlineKeyboard();
    for (const [kind, a] of Object.entries(AGENTS)) keyboard.text(`${a.emoji} ${a.label}`, `new:a:${kind}`);
    return keyboard.row().text("Cancel", "new:x");
  }

  function hostKeyboard(): InlineKeyboard {
    const keyboard = new InlineKeyboard().text(`🏠 ${localName}`, "new:h:");
    let col = 1;
    for (const name of remoteHosts) {
      if (col++ % 2 === 0) keyboard.row();
      keyboard.text(`🖥 ${name}`, `new:h:${name}`);
    }
    return keyboard.row().text("Cancel", "new:x");
  }

  /**
   * Open the /new menu. `task` becomes the session's first prompt once the
   * computer and agent are picked; `replyTo` attaches the menu to the message it came from.
   */
  async function openWizard(ctx: Context, task: string | undefined, replyTo?: number): Promise<void> {
    // With remote hosts, the computer comes first; otherwise straight to the agent.
    const [question, keyboard] = remoteHosts.length ? ["Which computer?", hostKeyboard()] : ["Which agent?", agentKeyboard()];
    const msg = await ctx.reply(newPrompt(task, question), {
      parse_mode: "HTML",
      reply_markup: keyboard,
      message_thread_id: topicOf(ctx),
      ...(replyTo === undefined ? {} : { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } }),
    });
    wizards.set(msg.message_id, { task, userId: ctx.from!.id });
    if (wizards.size > MAX_WIZARDS) wizards.delete(wizards.keys().next().value!);
  }

  bot.command("new", async (ctx) => {
    // `/new` sent as a reply to a message takes that message as the task.
    const replied = ctx.msg.reply_to_message;
    const quoted = ctx.match.trim() ? undefined : replied?.text?.trim() ||
      (replied?.voice ? await voicePrompt(ctx, replied.voice, replied.message_id) : undefined);
    if (!ctx.match.trim() && replied?.voice && !quoted) return;
    const task = ctx.match.trim() || quoted || undefined;
    await openWizard(ctx, task, quoted ? replied!.message_id : undefined);
  });

  bot.command("list", async (ctx) => {
    const open = store.list().filter((r) => !r.closed);
    if (open.length === 0) return void (await ctx.reply("No open sessions. Start one with /new.", { message_thread_id: topicOf(ctx) }));
    const lines = open.map((r) => {
      const busy = manager.isBusy(r.topicId) ? " · ⏳ working" : "";
      const where = r.host ? `${escapeHtml(r.host)}:${escapeHtml(r.project)}` : escapeHtml(r.project);
      return `${ACTIVITY[activityOf(r)].emoji} <a href="${topicLink(r.topicId)}">${escapeHtml(r.title)}</a> · ${AGENTS[r.agent].label} · ${where}${busy}`;
    });
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML", message_thread_id: topicOf(ctx), link_preview_options: { is_disabled: true } });
  });

  bot.command("stop", async (ctx) => {
    const topicId = topicOf(ctx);
    if (topicId === undefined) return void (await ctx.reply("Use /stop inside a session thread."));
    const stopped = await manager.stop(topicId);
    await ctx.reply(stopped ? "⏹ Stopping…" : "Nothing is running.", { message_thread_id: topicId });
  });

  bot.command("end", async (ctx) => {
    const topicId = topicOf(ctx);
    const rec = topicId === undefined ? undefined : store.get(topicId);
    if (topicId === undefined || !rec || rec.closed) return void (await ctx.reply("Use /end inside an open session thread.", { message_thread_id: topicId }));
    await manager.end(topicId);
    await ctx.reply(
      `Session ended. Its transcript stays on ${escapeHtml(hostLabel(rec.host))}${rec.sessionId ? ` (<code>${escapeHtml(rec.sessionId)}</code>)` : ""}.`,
      { parse_mode: "HTML", message_thread_id: topicId },
    );
    await bot.api.closeForumTopic(chatId!, topicId).catch((err) => log.warn("closeForumTopic failed", String(err)));
  });

  bot.command("status", async (ctx) => {
    const topicId = topicOf(ctx);
    const rec = topicId === undefined ? undefined : store.get(topicId);
    if (!rec) return void (await ctx.reply("Use /status inside a session thread.", { message_thread_id: topicId }));
    const lines = [
      `${AGENTS[rec.agent].emoji} <b>${AGENTS[rec.agent].label}</b> · ${escapeHtml(rec.project)}`,
      `host: ${escapeHtml(hostLabel(rec.host))} (${rec.host ? "remote" : "local"})`,
      `folder: <code>${escapeHtml(rec.cwd)}</code>`,
      `session: <code>${escapeHtml(rec.sessionId ?? "not started")}</code>`,
      `model: ${escapeHtml(await catalog(rec.host).label(rec.agent, rec.model))}`,
      `effort: ${escapeHtml(await catalog(rec.host).effortLabel(rec.agent, rec.model, rec.effort))}`,
      rec.agent === "claude"
        ? `permissions: ${escapeHtml(cfg.claude.permissionMode)}${claudeBypass ? " (full access, no prompts)" : " (asks here when needed)"}`
        : `sandbox: ${escapeHtml(cfg.codex.sandboxMode)}${codexFull ? " (full access)" : `, network ${cfg.codex.networkAccess ? "on" : "off"}`}`,
      `state: ${ACTIVITY[activityOf(rec)].emoji} ${activityOf(rec)}`,
    ];
    await ctx.reply(lines.join("\n"), {
      parse_mode: "HTML",
      message_thread_id: topicId,
      reply_markup: rec.closed ? undefined : new InlineKeyboard().text("🧠 Change model", "mdl:o").text("⚡ Change effort", "eff:o"),
    });
  });

  bot.command("model", async (ctx) => {
    const topicId = topicOf(ctx);
    const rec = topicId === undefined ? undefined : store.get(topicId);
    if (!rec || rec.closed) return void (await ctx.reply("Use /model inside an open session thread.", { message_thread_id: topicId }));
    const menu = await modelMenu(rec);
    await ctx.reply(menu.text, { parse_mode: "HTML", message_thread_id: topicId, reply_markup: menu.keyboard });
  });

  // --- model picker -------------------------------------------------------------------
  async function modelMenu(rec: SessionRecord): Promise<{ text: string; keyboard: InlineKeyboard }> {
    const a = AGENTS[rec.agent];
    const current = rec.model ?? "";
    const keyboard = new InlineKeyboard();
    let col = 0;
    for (const m of await catalog(rec.host).list(rec.agent)) {
      const data = `mdl:s:${m.value}`;
      if (Buffer.byteLength(data) > 64) continue; // Telegram's callback data limit
      keyboard.text(`${m.value === current ? "✓ " : ""}${m.label}`, data);
      if (++col % 2 === 0) keyboard.row();
    }
    if (col % 2 !== 0) keyboard.row();
    keyboard.text("Close", "mdl:x");
    const when = rec.agent === "claude" ? "Claude switches from its next response, also mid-turn." : "Codex switches from its next turn.";
    const text =
      `🧠 <b>Model</b> · ${a.emoji} ${a.label}\n` +
      `Now: <b>${escapeHtml(await catalog(rec.host).label(rec.agent, rec.model))}</b>\n` +
      `<i>${when}</i>`;
    return { text, keyboard };
  }

  bot.callbackQuery(/^mdl:/, async (ctx) => {
    const topicId = topicOf(ctx);
    const rec = topicId === undefined ? undefined : store.get(topicId);
    if (topicId === undefined || !rec || rec.closed) {
      return void (await ctx.answerCallbackQuery({ text: "This session has ended." }));
    }
    const data = ctx.callbackQuery.data;

    if (data === "mdl:x") {
      await ctx.answerCallbackQuery();
      return void (await ctx.deleteMessage().catch(() => ctx.editMessageReplyMarkup()));
    }
    if (data === "mdl:o") {
      await ctx.answerCallbackQuery();
      const menu = await modelMenu(rec);
      return void (await ctx.reply(menu.text, { parse_mode: "HTML", message_thread_id: topicId, reply_markup: menu.keyboard }));
    }
    if (data.startsWith("mdl:s:")) {
      const value = data.slice("mdl:s:".length);
      const models = catalog(rec.host);
      const choice = (await models.list(rec.agent)).find((m) => m.value === value);
      if (!choice) return void (await ctx.answerCallbackQuery({ text: "That model is no longer offered. Run /model again." }));
      if (value === (rec.model ?? "")) {
        return void (await ctx.answerCallbackQuery({ text: `Already on ${choice.label}.` }));
      }
      // An effort the new model doesn't take goes back to the default.
      const dropEffort = rec.effort !== undefined && !(await models.supportsEffort(rec.agent, value || undefined, rec.effort));
      try {
        await manager.setModel(topicId, value || undefined);
        if (dropEffort) await manager.setEffort(topicId, undefined);
      } catch (err) {
        log.warn("setModel failed", String(err));
        return void (await ctx.answerCallbackQuery({ text: `Could not switch: ${String(err).slice(0, 150)}` }));
      }
      await ctx.answerCallbackQuery({ text: `Model: ${choice.label}` });
      const label = await models.label(rec.agent, value || undefined);
      const when = rec.agent === "claude" ? "from Claude's next response" : manager.isBusy(topicId) ? "from Codex's next turn" : "from the next message";
      log.info(`topic ${topicId}: model → ${value || "default"}`);
      const effortNote = dropEffort
        ? `\n⚡ ${escapeHtml(choice.label)} has no <b>${escapeHtml(rec.effort!)}</b> effort: back to ${escapeHtml(await models.effortLabel(rec.agent, value || undefined, undefined))}.`
        : "";
      return void (await ctx.editMessageText(`🧠 Model → <b>${escapeHtml(label)}</b>\n<i>Applies ${when}.</i>${effortNote}`, { parse_mode: "HTML" }));
    }
    await ctx.answerCallbackQuery({ text: "Unknown choice." });
  });

  bot.command("effort", async (ctx) => {
    const topicId = topicOf(ctx);
    const rec = topicId === undefined ? undefined : store.get(topicId);
    if (!rec || rec.closed) return void (await ctx.reply("Use /effort inside an open session thread.", { message_thread_id: topicId }));
    const menu = await effortMenu(rec);
    await ctx.reply(menu.text, { parse_mode: "HTML", message_thread_id: topicId, reply_markup: menu.keyboard });
  });

  // --- effort picker ------------------------------------------------------------------
  async function effortMenu(rec: SessionRecord): Promise<{ text: string; keyboard: InlineKeyboard }> {
    const a = AGENTS[rec.agent];
    const current = rec.effort ?? "";
    const keyboard = new InlineKeyboard();
    let col = 0;
    const models = catalog(rec.host);
    for (const e of await models.efforts(rec.agent, rec.model)) {
      keyboard.text(`${e.value === current ? "✓ " : ""}${e.label}`, `eff:s:${e.value}`);
      if (++col % 3 === 0) keyboard.row();
    }
    if (col % 3 !== 0) keyboard.row();
    keyboard.text("Close", "eff:x");
    const when = rec.agent === "claude" ? "Claude switches from its next response, also mid-turn." : "Codex switches from its next turn.";
    const text =
      `⚡ <b>Effort</b> · ${a.emoji} ${a.label} · ${escapeHtml(await models.label(rec.agent, rec.model))}\n` +
      `Now: <b>${escapeHtml(await models.effortLabel(rec.agent, rec.model, rec.effort))}</b>\n` +
      `<i>${when}</i>`;
    return { text, keyboard };
  }

  bot.callbackQuery(/^eff:/, async (ctx) => {
    const topicId = topicOf(ctx);
    const rec = topicId === undefined ? undefined : store.get(topicId);
    if (topicId === undefined || !rec || rec.closed) {
      return void (await ctx.answerCallbackQuery({ text: "This session has ended." }));
    }
    const data = ctx.callbackQuery.data;

    if (data === "eff:x") {
      await ctx.answerCallbackQuery();
      return void (await ctx.deleteMessage().catch(() => ctx.editMessageReplyMarkup()));
    }
    if (data === "eff:o") {
      await ctx.answerCallbackQuery();
      const menu = await effortMenu(rec);
      return void (await ctx.reply(menu.text, { parse_mode: "HTML", message_thread_id: topicId, reply_markup: menu.keyboard }));
    }
    if (data.startsWith("eff:s:")) {
      const value = data.slice("eff:s:".length);
      const choice = (await catalog(rec.host).efforts(rec.agent, rec.model)).find((e) => e.value === value);
      if (!choice) return void (await ctx.answerCallbackQuery({ text: "This model doesn't offer that effort. Run /effort again." }));
      if (value === (rec.effort ?? "")) {
        return void (await ctx.answerCallbackQuery({ text: `Already on ${choice.label}.` }));
      }
      try {
        await manager.setEffort(topicId, value || undefined);
      } catch (err) {
        log.warn("setEffort failed", String(err));
        return void (await ctx.answerCallbackQuery({ text: `Could not switch: ${String(err).slice(0, 150)}` }));
      }
      await ctx.answerCallbackQuery({ text: `Effort: ${choice.label}` });
      const when = rec.agent === "claude" ? "from Claude's next response" : manager.isBusy(topicId) ? "from Codex's next turn" : "from the next message";
      log.info(`topic ${topicId}: effort → ${value || "default"}`);
      return void (await ctx.editMessageText(`⚡ Effort → <b>${escapeHtml(choice.label)}</b>\n<i>Applies ${when}.</i>`, { parse_mode: "HTML" }));
    }
    await ctx.answerCallbackQuery({ text: "Unknown choice." });
  });

  // --- /new wizard ------------------------------------------------------------------
  bot.callbackQuery(/^new:/, async (ctx) => {
    const messageId = ctx.callbackQuery.message?.message_id;
    const wizard = messageId === undefined ? undefined : wizards.get(messageId);
    if (!wizard || wizard.userId !== ctx.from.id) {
      return void (await ctx.answerCallbackQuery({ text: "This menu has expired. Run /new again." }));
    }
    const [, step, value] = ctx.callbackQuery.data.split(":");

    if (step === "x") {
      wizards.delete(messageId!);
      await ctx.answerCallbackQuery();
      return void (await ctx.deleteMessage().catch(() => ctx.editMessageText("Cancelled.")));
    }
    if (step === "h" && value !== undefined && (value === "" || remoteHosts.includes(value))) {
      wizard.host = value || undefined;
      await ctx.answerCallbackQuery();
      const on = `on <b>${escapeHtml(hostLabel(wizard.host))}</b>. Which agent?`;
      return void (await ctx.editMessageText(newPrompt(wizard.task, on), { parse_mode: "HTML", reply_markup: agentKeyboard() }));
    }
    if (step === "a" && (value === "claude" || value === "codex")) {
      wizard.agent = value;
      await ctx.answerCallbackQuery();
      const project = wizard.host ? { name: hosts!.config(wizard.host).cwd, path: hosts!.config(wizard.host).cwd } : cfg.workdir;
      return finish(ctx, messageId!, wizard, project);
    }
    await ctx.answerCallbackQuery({ text: "Unknown choice." });
  });

  async function finish(ctx: Context, menuId: number, wizard: Wizard, project: Project): Promise<void> {
    wizards.delete(menuId);
    const agent = wizard.agent!;
    const a = AGENTS[agent];
    const title = wizard.task ? clip(firstLine(wizard.task), 60) : `New ${a.label} session`;
    let topicId: number;
    try {
      topicId = (await bot.api.createForumTopic(chatId!, topicName(title))).message_thread_id;
    } catch (err) {
      log.error("createForumTopic failed", String(err));
      const rights = /not enough rights/i.test(String(err));
      await ctx.editMessageText(
        rights
          ? "❌ I can't create threads here. Make me an admin with <b>Manage Topics</b> (group settings → Administrators), then run /new again."
          : `❌ Could not create the thread: <code>${escapeHtml(String(err).slice(0, 300))}</code>`,
        { parse_mode: "HTML" },
      );
      return;
    }
    manager.create(topicId, agent, project, title, !wizard.task, wizard.host);
    const on = wizard.host ? ` on <b>${escapeHtml(wizard.host)}</b>` : "";

    await ctx.editMessageText(`${a.emoji} <b>${a.label}</b>${on} → <a href="${topicLink(topicId)}">${escapeHtml(title)}</a>`, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
    await manager.initializeTopic(topicId);
    if (wizard.task) await sendTo(topicId, wizard.task);
  }

  /** Pass a message to a session; a session that can't start says why in its thread. */
  async function sendTo(topicId: number, text: string): Promise<void> {
    try {
      manager.send(topicId, text);
    } catch (err) {
      log.warn(`topic ${topicId}: send failed`, String(err));
      await bot.api.sendMessage(chatId!, `❌ ${escapeHtml(err instanceof Error ? err.message : String(err))}`, {
        message_thread_id: topicId,
        parse_mode: "HTML",
      });
    }
  }

  // --- buttons from running sessions ---------------------------------------------------
  bot.callbackQuery(/^perm:/, async (ctx) => {
    const ok = await permissions.answer(ctx.callbackQuery.data);
    await ctx.answerCallbackQuery(ok ? undefined : { text: "This request is no longer pending." });
  });

  bot.callbackQuery(/^stop:\d+$/, async (ctx) => {
    const stopped = await manager.stop(Number(ctx.callbackQuery.data.slice(5)));
    await ctx.answerCallbackQuery({ text: stopped ? "Stopping…" : "Nothing is running." });
  });

  // --- conversation -------------------------------------------------------------------
  async function routePrompt(ctx: Context, text: string): Promise<void> {
    const topicId = topicOf(ctx);
    if (topicId === undefined) {
      // A message in General is a task: ask where and with which agent, then open a thread for it.
      return openWizard(ctx, text.trim(), ctx.msg!.message_id);
    }
    const rec = store.get(topicId);
    if (!rec) return void (await ctx.reply("This thread isn't linked to an agent. Start one with /new.", { message_thread_id: topicId }));
    if (rec.closed) return void (await ctx.reply("This session has ended. Start a new one with /new.", { message_thread_id: topicId }));

    await sendTo(topicId, text);
  }

  /** Show progress and a literal preview; only the full transcript goes to the agent. */
  async function voicePrompt(ctx: Context, voice: Voice, messageId: number): Promise<string | undefined> {
    const progress = await ctx.reply("🎙 Transcribing…", {
      message_thread_id: topicOf(ctx),
      reply_parameters: { message_id: messageId, allow_sending_without_reply: true },
    });
    let text: string;
    try {
      text = await transcribeVoice(voice);
    } catch (err) {
      const message = err instanceof VoiceError ? err.message : "Could not transcribe the voice message. Please try again, or send the prompt as text.";
      log.warn("voice transcription failed:", message);
      await bot.api.editMessageText(ctx.chat!.id, progress.message_id, `❌ ${message}`);
      return;
    }
    await bot.api.editMessageText(ctx.chat!.id, progress.message_id, `🎙 ${clip(text, 3800)}`);
    return text;
  }

  bot.on("message:text", async (ctx) => {
    if (topicOf(ctx) === undefined && (!ctx.msg.text.trim() || ctx.msg.text.trim().startsWith("/"))) {
      return void (await ctx.reply("Start a session with /new. Each session gets its own thread."));
    }
    await routePrompt(ctx, ctx.msg.text);
  });

  bot.on("message:voice", async (ctx) => {
    const topicId = topicOf(ctx);
    // Reject ended/unlinked threads before downloading audio or running inference.
    if (topicId !== undefined) {
      const rec = store.get(topicId);
      if (!rec || rec.closed) return routePrompt(ctx, "");
    }
    const text = await voicePrompt(ctx, ctx.msg.voice, ctx.msg.message_id);
    if (text) await routePrompt(ctx, text);
  });

  bot.on(["message:photo", "message:document", "message:video", "message:audio"], (ctx) =>
    ctx.reply("Send a text or voice message. Other attachments aren't supported yet.", { message_thread_id: topicOf(ctx) }),
  );

  bot.catch((err) => log.error(`update ${err.ctx.update.update_id} failed`, err.error));
}
