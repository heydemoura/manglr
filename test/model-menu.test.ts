import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Bot } from "grammy";
import type { Update } from "grammy/types";
import type { Config } from "../src/config.js";
import type { ModelCatalog, ModelChoice } from "../src/models.js";
import type { SessionManager } from "../src/sessions.js";
import { SessionStore } from "../src/store.js";
import { registerHandlers } from "../src/telegram/bot.js";
import type { PermissionBroker } from "../src/telegram/permissions.js";

const CHAT = { id: -1001234567890, type: "supergroup" as const, title: "agents", is_forum: true as const };
const USER = { id: 42, is_bot: false, first_name: "me" };
const TOPIC = 7;

const CLAUDE_MODELS: ModelChoice[] = [
  { value: "", label: "Default", description: "Opus 5.5" },
  { value: "opus", label: "Opus 5.5" },
  { value: "sonnet", label: "Sonnet 5.5" },
  { value: "haiku", label: "Haiku 5.5" },
];

interface Call {
  method: string;
  payload: Record<string, any>;
}

/** The real handlers on a bot whose API calls are recorded instead of sent. */
function harness() {
  const calls: Call[] = [];
  const bot = new Bot("1:fake", { botInfo: { id: 1, is_bot: true, first_name: "bot", username: "manglr" } as any });
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, any> });
    const result =
      method === "sendMessage"
        ? { message_id: 100 + calls.length, chat: CHAT, date: 0 }
        : method === "createForumTopic"
          ? { message_thread_id: TOPIC + 1, name: "t", icon_color: 0 }
          : true;
    return { ok: true, result } as any;
  });

  const store = new SessionStore(mkdtempSync(path.join(tmpdir(), "manglr-test-")));
  store.upsert({ topicId: TOPIC, agent: "claude", project: "p", cwd: "/tmp", title: "t" });
  const switched: (string | undefined)[] = [];
  const started: string[] = [];
  const manager = {
    isBusy: () => false,
    create: (topicId: number, agent: "claude" | "codex", project: { name: string; path: string }, title: string, autoTitle: boolean) =>
      store.upsert({ topicId, agent, project: project.name, cwd: project.path, title, autoTitle }),
    send: (_topicId: number, text: string) => void started.push(text),
    setModel: async (topicId: number, model: string | undefined) => {
      switched.push(model);
      store.update(topicId, { model });
    },
  } as unknown as SessionManager;
  const models = {
    list: async () => CLAUDE_MODELS,
    defaultName: async () => CLAUDE_MODELS[0]!.description,
    label: async (_a: string, v: string | undefined) => {
      const m = CLAUDE_MODELS.find((x) => x.value === (v ?? ""))!;
      return v ? m.label : `${m.label} (${m.description})`;
    },
  } as unknown as ModelCatalog;
  const cfg = {
    telegram: { token: "1:fake", chatId: CHAT.id, allowedUserIds: new Set([USER.id]) },
    setupMode: false,
    workdir: { name: "/tmp", path: "/tmp" },
    dataDir: "/tmp",
    claude: { permissionMode: "default" },
    codex: { sandboxMode: "workspace-write", networkAccess: false },
  } as Config;
  registerHandlers(bot, cfg, store, manager, {} as PermissionBroker, models);

  let updateId = 0;
  const send = (text: string, topic: number | null = TOPIC) =>
    bot.handleUpdate({
      update_id: ++updateId,
      message: {
        message_id: updateId,
        date: 0,
        chat: CHAT,
        from: USER,
        text,
        ...(topic === null ? {} : { message_thread_id: topic, is_topic_message: true }),
        ...(text.startsWith("/") ? { entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }] } : {}),
      },
    } as Update);
  const tap = (data: string, messageId = 99) =>
    bot.handleUpdate({
      update_id: ++updateId,
      callback_query: {
        id: String(updateId),
        from: USER,
        chat_instance: "x",
        data,
        message: { message_id: messageId, date: 0, chat: CHAT, text: "menu", message_thread_id: TOPIC, is_topic_message: true },
      },
    } as Update);
  return { bot, calls, store, switched, started, send, tap };
}

const buttons = (call: Call): { text: string; callback_data: string }[] => call.payload.reply_markup.inline_keyboard.flat();
const last = (calls: Call[], method: string) => calls.filter((c) => c.method === method).at(-1)!;

test("/model in a thread shows the picker with the current model checked", async () => {
  const h = harness();
  await h.bot.init();
  await h.send("/model");
  const msg = last(h.calls, "sendMessage");
  assert.equal(msg.payload.message_thread_id, TOPIC);
  assert.match(msg.payload.text, /Now: <b>Default \(Opus 5\.5\)<\/b>/);
  assert.deepEqual(
    buttons(msg).map((b) => [b.text, b.callback_data]),
    [
      ["✓ Default", "mdl:s:"],
      ["Opus 5.5", "mdl:s:opus"],
      ["Sonnet 5.5", "mdl:s:sonnet"],
      ["Haiku 5.5", "mdl:s:haiku"],
      ["Close", "mdl:x"],
    ],
  );
});

test("tapping a model switches the session and confirms in place", async () => {
  const h = harness();
  await h.bot.init();
  await h.tap("mdl:s:sonnet");
  assert.deepEqual(h.switched, ["sonnet"]);
  assert.equal(h.store.get(TOPIC)!.model, "sonnet");
  assert.equal(last(h.calls, "answerCallbackQuery").payload.text, "Model: Sonnet 5.5");
  assert.match(last(h.calls, "editMessageText").payload.text, /Model → <b>Sonnet 5\.5<\/b>/);

  // The menu now checks the new model, and Default switches back.
  await h.send("/model");
  assert.equal(buttons(last(h.calls, "sendMessage")).find((b) => b.text.startsWith("✓"))!.callback_data, "mdl:s:sonnet");
  await h.tap("mdl:s:");
  assert.deepEqual(h.switched, ["sonnet", undefined]);
  assert.equal(h.store.get(TOPIC)!.model, undefined);
});

test("unknown or unchanged choices do not switch", async () => {
  const h = harness();
  await h.bot.init();
  await h.tap("mdl:s:gpt-nope");
  assert.match(last(h.calls, "answerCallbackQuery").payload.text, /no longer offered/);
  await h.tap("mdl:s:");
  assert.match(last(h.calls, "answerCallbackQuery").payload.text, /Already on Default/);
  assert.deepEqual(h.switched, []);
});

test("the 🧠 button on /status opens the picker; /model outside a thread explains", async () => {
  const h = harness();
  await h.bot.init();
  await h.send("/status");
  assert.deepEqual(buttons(last(h.calls, "sendMessage")), [{ text: "🧠 Change model", callback_data: "mdl:o" }]);
  await h.tap("mdl:o");
  assert.match(last(h.calls, "sendMessage").payload.text, /🧠 <b>Model<\/b>/);
  await h.send("/model", null); // General, not a thread
  assert.match(last(h.calls, "sendMessage").payload.text, /inside an open session thread/);
});

test("ended sessions refuse model changes", async () => {
  const h = harness();
  await h.bot.init();
  h.store.update(TOPIC, { closed: true });
  await h.tap("mdl:s:haiku");
  assert.equal(last(h.calls, "answerCallbackQuery").payload.text, "This session has ended.");
  assert.deepEqual(h.switched, []);
});

test("a new thread starts on the host's default model without asking", async () => {
  const h = harness();
  await h.bot.init();
  await h.send("/new fix the tests", null);
  const menu = last(h.calls, "sendMessage");
  await h.tap("new:a:claude", 100 + h.calls.indexOf(menu) + 1);
  const welcome = last(h.calls, "sendMessage");
  assert.equal(welcome.payload.message_thread_id, TOPIC + 1);
  assert.match(welcome.payload.text, /🧠 Opus 5\.5 <i>\(default, \/model to switch\)<\/i>/);
  assert.equal(welcome.payload.reply_markup, undefined);
  assert.equal(h.store.get(TOPIC + 1)!.model, undefined);
  assert.deepEqual(h.started, ["fix the tests"]);
});
