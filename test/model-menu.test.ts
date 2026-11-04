import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Bot } from "grammy";
import type { Update } from "grammy/types";
import type { Config } from "../src/config.js";
import { ModelCatalog, type ModelChoice } from "../src/models.js";
import type { SessionManager } from "../src/sessions.js";
import { SessionStore } from "../src/store.js";
import { registerHandlers } from "../src/telegram/bot.js";
import type { PermissionBroker } from "../src/telegram/permissions.js";
import type { HostDirectory } from "../src/remote/registry.js";

const CHAT = { id: -1001234567890, type: "supergroup" as const, title: "agents", is_forum: true as const };
const USER = { id: 42, is_bot: false, first_name: "me" };
const TOPIC = 7;

const ALL = ["low", "medium", "high", "xhigh", "max"];
const CLAUDE_MODELS: ModelChoice[] = [
  { value: "", label: "Default", description: "Opus 5.5", efforts: ALL },
  { value: "opus", label: "Opus 5.5", efforts: ALL },
  { value: "sonnet", label: "Sonnet 5.5", efforts: ["low", "medium", "high"] },
  { value: "haiku", label: "Haiku 5.5", efforts: [] },
];

interface Call {
  method: string;
  payload: Record<string, any>;
}

/** The real handlers on a bot whose API calls are recorded instead of sent. */
function harness(hosts?: HostDirectory) {
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
  const efforts: (string | undefined)[] = [];
  const started: string[] = [];
  const manager = {
    isBusy: () => false,
    create: (topicId: number, agent: "claude" | "codex", project: { name: string; path: string }, title: string, autoTitle: boolean, host?: string) =>
      store.upsert({ topicId, agent, host, project: project.name, cwd: project.path, title, autoTitle }),
    send: (_topicId: number, text: string) => void started.push(text),
    setModel: async (topicId: number, model: string | undefined) => {
      switched.push(model);
      store.update(topicId, { model });
    },
    setEffort: async (topicId: number, effort: string | undefined) => {
      efforts.push(effort);
      store.update(topicId, { effort });
    },
  } as unknown as SessionManager;
  const cfg = {
    telegram: { token: "1:fake", chatId: CHAT.id, allowedUserIds: new Set([USER.id]) },
    setupMode: false,
    workdir: { name: "/tmp", path: "/tmp" },
    dataDir: "/tmp",
    claude: { permissionMode: "default" },
    codex: { sandboxMode: "workspace-write", networkAccess: false },
  } as Config;
  // The real catalog, with the list Claude Code would report.
  const models = new ModelCatalog(cfg);
  models.list = async () => CLAUDE_MODELS;
  registerHandlers(bot, cfg, store, manager, {} as PermissionBroker, models, hosts);

  let updateId = 0;
  const send = (text: string, topic: number | null = TOPIC, extra: Record<string, unknown> = {}) =>
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
        ...extra,
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
  return { bot, calls, store, switched, efforts, started, send, tap };
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
  assert.deepEqual(buttons(last(h.calls, "sendMessage")), [
    { text: "🧠 Change model", callback_data: "mdl:o" },
    { text: "⚡ Change effort", callback_data: "eff:o" },
  ]);
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
  assert.match(welcome.payload.text, /⚡ Default effort <i>\(\/effort to switch\)<\/i>/);
  assert.equal(welcome.payload.reply_markup, undefined);
  assert.equal(h.store.get(TOPIC + 1)!.model, undefined);
  assert.deepEqual(h.started, ["fix the tests"]);
});

test("/effort lists the current model's levels with the current one checked", async () => {
  const h = harness();
  await h.bot.init();
  await h.send("/effort");
  const msg = last(h.calls, "sendMessage");
  assert.equal(msg.payload.message_thread_id, TOPIC);
  assert.match(msg.payload.text, /⚡ <b>Effort<\/b> · 🟠 Claude · Default \(Opus 5\.5\)/);
  assert.match(msg.payload.text, /Now: <b>Default<\/b>/);
  assert.deepEqual(
    buttons(msg).map((b) => b.callback_data),
    ["eff:s:", "eff:s:low", "eff:s:medium", "eff:s:high", "eff:s:xhigh", "eff:s:max", "eff:x"],
  );
  assert.equal(buttons(msg)[0]!.text, "✓ Default");

  // On Sonnet only its own levels are offered.
  h.store.update(TOPIC, { model: "sonnet" });
  await h.send("/effort");
  assert.deepEqual(
    buttons(last(h.calls, "sendMessage")).map((b) => b.callback_data),
    ["eff:s:", "eff:s:low", "eff:s:medium", "eff:s:high", "eff:x"],
  );
});

test("tapping an effort switches the session; Default switches back", async () => {
  const h = harness();
  await h.bot.init();
  await h.tap("eff:s:xhigh");
  assert.deepEqual(h.efforts, ["xhigh"]);
  assert.equal(h.store.get(TOPIC)!.effort, "xhigh");
  assert.equal(last(h.calls, "answerCallbackQuery").payload.text, "Effort: xhigh");
  assert.match(last(h.calls, "editMessageText").payload.text, /Effort → <b>xhigh<\/b>\n<i>Applies from Claude's next response\.<\/i>/);

  await h.send("/status");
  assert.match(last(h.calls, "sendMessage").payload.text, /effort: xhigh/);

  await h.tap("eff:s:xhigh");
  assert.match(last(h.calls, "answerCallbackQuery").payload.text, /Already on xhigh/);
  await h.tap("eff:s:");
  assert.deepEqual(h.efforts, ["xhigh", undefined]);
  assert.equal(h.store.get(TOPIC)!.effort, undefined);
});

test("efforts the model doesn't offer are refused", async () => {
  const h = harness();
  await h.bot.init();
  h.store.update(TOPIC, { model: "haiku" });
  await h.send("/effort");
  assert.deepEqual(buttons(last(h.calls, "sendMessage")).map((b) => b.callback_data), ["eff:s:", "eff:x"]);
  await h.tap("eff:s:high");
  assert.match(last(h.calls, "answerCallbackQuery").payload.text, /doesn't offer that effort/);
  assert.deepEqual(h.efforts, []);
});

test("switching to a model without the current effort resets it to the default", async () => {
  const h = harness();
  await h.bot.init();
  h.store.update(TOPIC, { effort: "max" });
  await h.tap("mdl:s:sonnet");
  assert.deepEqual(h.switched, ["sonnet"]);
  assert.deepEqual(h.efforts, [undefined]);
  assert.match(last(h.calls, "editMessageText").payload.text, /Sonnet 5\.5 has no <b>max<\/b> effort: back to Default\./);

  // A level the new model has is kept.
  h.store.update(TOPIC, { effort: "high" });
  await h.tap("mdl:s:opus");
  assert.deepEqual(h.efforts, [undefined]);
  assert.equal(h.store.get(TOPIC)!.effort, "high");
});

test("ended sessions refuse effort changes", async () => {
  const h = harness();
  await h.bot.init();
  h.store.update(TOPIC, { closed: true });
  await h.tap("eff:s:low");
  assert.equal(last(h.calls, "answerCallbackQuery").payload.text, "This session has ended.");
  assert.deepEqual(h.efforts, []);
});

test("with remote hosts, /new asks for the computer first and the thread runs there", async () => {
  const remote = new ModelCatalog({ workdir: { path: "~" }, claude: {}, codex: {} });
  remote.list = async () => [{ value: "", label: "Default", description: "Sonnet 5.5", efforts: [] }];
  const hosts: HostDirectory = {
    names: () => ["bazzite", "debian"],
    config: (name) => ({ name, ssh: name, cwd: "~/Code", command: "runner" }),
    catalog: () => remote,
  };
  const h = harness(hosts);
  await h.bot.init();
  await h.send("/new fix the tests", null);
  const menu = last(h.calls, "sendMessage");
  assert.match(menu.payload.text, /Which computer\?/);
  const picks = buttons(menu).map((b) => b.callback_data);
  assert.deepEqual(picks.slice(1), ["new:h:bazzite", "new:h:debian", "new:x"]);
  assert.equal(picks[0], "new:h:", "this host comes first");

  const menuId = 100 + h.calls.indexOf(menu) + 1;
  await h.tap("new:h:nope", menuId);
  assert.equal(last(h.calls, "answerCallbackQuery").payload.text, "Unknown choice.");
  await h.tap("new:h:bazzite", menuId);
  const agentMenu = last(h.calls, "editMessageText");
  assert.match(agentMenu.payload.text, /on <b>bazzite<\/b>\. Which agent\?/);
  assert.deepEqual(buttons(agentMenu).map((b) => b.callback_data), ["new:a:claude", "new:a:codex", "new:x"]);

  await h.tap("new:a:claude", menuId);
  assert.equal(last(h.calls, "createForumTopic").payload.name, "🟠 bazzite: fix the tests");
  const rec = h.store.get(TOPIC + 1)!;
  assert.equal(rec.host, "bazzite");
  assert.equal(rec.cwd, "~/Code");
  const welcome = last(h.calls, "sendMessage");
  assert.match(welcome.payload.text, /on <b>bazzite<\/b> in <code>~\/Code<\/code>/);
  assert.match(welcome.payload.text, /🧠 Sonnet 5\.5/, "the remote host's default model");
  assert.deepEqual(h.started, ["fix the tests"]);

  await h.send("/status", TOPIC + 1);
  assert.match(last(h.calls, "sendMessage").payload.text, /host: bazzite/);
});

const REMOTE_HOSTS = (): HostDirectory => {
  const remote = new ModelCatalog({ workdir: { path: "~" }, claude: {}, codex: {} });
  remote.list = async () => [{ value: "", label: "Default", description: "Sonnet 5.5", efforts: [] }];
  return {
    names: () => ["bazzite", "debian"],
    config: (name) => ({ name, ssh: name, cwd: "~/Code", command: "runner" }),
    catalog: () => remote,
  };
};

test("a message in General becomes the first prompt of a new thread, after picking computer and agent", async () => {
  const h = harness(REMOTE_HOSTS());
  await h.bot.init();
  const task = "Fix the flaky upload test\nIt fails on CI about once in ten runs.";
  await h.send(task, null);
  const sourceId = 1; // the first update's message_id
  const menu = last(h.calls, "sendMessage");
  assert.equal(menu.payload.message_thread_id, undefined, "the menu stays in General");
  assert.equal(menu.payload.reply_parameters.message_id, sourceId, "attached to the captured message");
  assert.match(menu.payload.text, /New session for:\n<i>Fix the flaky upload test/);
  assert.match(menu.payload.text, /Which computer\?/);
  assert.equal(h.calls.filter((c) => c.method === "createForumTopic").length, 0, "nothing starts before the picks");

  const menuId = 100 + h.calls.indexOf(menu) + 1;
  await h.tap("new:h:debian", menuId);
  assert.match(last(h.calls, "editMessageText").payload.text, /on <b>debian<\/b>\. Which agent\?/);
  assert.deepEqual(h.started, []);

  await h.tap("new:a:codex", menuId);
  assert.equal(last(h.calls, "createForumTopic").payload.name, "🟢 debian: Fix the flaky upload test");
  const rec = h.store.get(TOPIC + 1)!;
  assert.equal(rec.agent, "codex");
  assert.equal(rec.host, "debian");
  assert.equal(rec.autoTitle, false);
  assert.deepEqual(h.started, [task], "the whole captured message is the first prompt");
  assert.match(last(h.calls, "editMessageText").payload.text, /debian<\/b> → <a href="https:\/\/t\.me\/c\/1234567890\/8">/);

  // The menu is spent.
  await h.tap("new:a:claude", menuId);
  assert.equal(last(h.calls, "answerCallbackQuery").payload.text, "This menu has expired. Run /new again.");
});

test("without remote hosts, a General message only asks for the agent", async () => {
  const h = harness();
  await h.bot.init();
  await h.send("summarize the open PRs", null);
  const menu = last(h.calls, "sendMessage");
  assert.match(menu.payload.text, /Which agent\?/);
  assert.deepEqual(buttons(menu).map((b) => b.callback_data), ["new:a:claude", "new:a:codex", "new:x"]);
  await h.tap("new:a:claude", 100 + h.calls.indexOf(menu) + 1);
  assert.equal(last(h.calls, "createForumTopic").payload.name, "🟠 summarize the open PRs");
  assert.equal(h.store.get(TOPIC + 1)!.cwd, "/tmp");
  assert.deepEqual(h.started, ["summarize the open PRs"]);
});

test("cancelling a General message's menu starts nothing", async () => {
  const h = harness();
  await h.bot.init();
  await h.send("do the thing", null);
  const menuId = 100 + h.calls.indexOf(last(h.calls, "sendMessage")) + 1;
  await h.tap("new:x", menuId);
  assert.equal(last(h.calls, "deleteMessage").payload.message_id, menuId);
  await h.tap("new:a:claude", menuId);
  assert.equal(h.calls.filter((c) => c.method === "createForumTopic").length, 0);
  assert.deepEqual(h.started, []);
});

test("/new as a reply to a message takes that message as the task", async () => {
  const h = harness();
  await h.bot.init();
  const quoted = { message_id: 55, date: 0, chat: CHAT, from: USER, text: "port the player to the new API" };
  await h.send("/new", null, { reply_to_message: quoted });
  const menu = last(h.calls, "sendMessage");
  assert.match(menu.payload.text, /<i>port the player to the new API<\/i>/);
  assert.equal(menu.payload.reply_parameters.message_id, 55);
  await h.tap("new:a:claude", 100 + h.calls.indexOf(menu) + 1);
  assert.deepEqual(h.started, ["port the player to the new API"]);

  // A task typed after /new wins over the replied-to message.
  await h.send("/new something else", null, { reply_to_message: quoted });
  assert.match(last(h.calls, "sendMessage").payload.text, /<i>something else<\/i>/);
});

test("unknown commands in General still point to /new instead of becoming tasks", async () => {
  const h = harness();
  await h.bot.init();
  await h.send("/frobnicate", null);
  const reply = last(h.calls, "sendMessage");
  assert.equal(reply.payload.text, "Start a session with /new. Each session gets its own thread.");
  assert.equal(reply.payload.reply_markup, undefined);
});
