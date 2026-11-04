import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Api, GrammyError } from "grammy";
import type { AgentEvents, AgentSession, PermissionDecision } from "../src/agents/types.js";
import type { Config } from "../src/config.js";
import type { ModelCatalog } from "../src/models.js";
import type { HostRegistry } from "../src/remote/registry.js";
import { SessionManager } from "../src/sessions.js";
import { SessionStore } from "../src/store.js";
import type { TitleSummarizer } from "../src/topic-titles.js";
import type { PermissionBroker } from "../src/telegram/permissions.js";
import { SessionTopics, topicName } from "../src/telegram/session-topics.js";

const TOPIC = 7;
function fixture(t: TestContext, summarize: TitleSummarizer = async () => "Login redirect and regression tests") {
  const dir = mkdtempSync(path.join(tmpdir(), "manglr-topic-test-"));
  const cfg = {
    telegram: { chatId: -1001 },
    claude: { permissionMode: "default" }, codex: { sandboxMode: "workspace-write", networkAccess: false },
    topicTitleModel: "haiku",
  } as Config;
  const calls: { method: string; payload: Record<string, any> }[] = [];
  const failures = new Map<string, Error>();
  const api = new Api("1:fake");
  api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload });
    const failure = failures.get(method);
    if (failure) { failures.delete(method); throw failure; }
    return { ok: true, result: method === "sendMessage" ? { message_id: 100 + calls.length } : true } as any;
  });
  const store = new SessionStore(dir);
  store.upsert({ topicId: TOPIC, agent: "claude", project: "p", cwd: "/tmp/project", title: "New Claude session", autoTitle: true });
  const models = { label: async () => "Default (Opus)", effortLabel: async () => "Default" };
  const remoteModels = { label: async () => "Remote model", effortLabel: async () => "high" } as unknown as ModelCatalog;
  const hosts = { catalog: () => remoteModels } as unknown as HostRegistry;
  const topics = new SessionTopics(cfg, api, store, models, summarize, hosts, 1);
  t.after(async () => { await topics.shutdown(); rmSync(dir, { recursive: true, force: true }); });
  const last = (method: string) => calls.filter((call) => call.method === method).at(-1)!;
  return { cfg, api, store, models, hosts, topics, calls, last, failures };
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail("timed out waiting for background topic update");
    await delay(5);
  }
}

test("topic names use status instead of agent or host badges and stay within Telegram's limit", () => {
  assert.equal(topicName("Fix the login redirect", "working"), "⏳ Fix the login redirect");
  assert.equal(topicName("Login redirect", "ready"), "✅ Login redirect");
  assert.equal(topicName("Login redirect"), "💤 Login redirect");
  assert.equal(topicName("Login redirect", "ended"), "⏹ Login redirect");
  assert.ok(topicName("x".repeat(200)).length <= 128);
});

test("a local session gets one pinned card with host, agent, folder, model and state; updates edit it", async (t) => {
  const h = fixture(t);
  await h.topics.refresh(TOPIC);
  const card = h.last("sendMessage");
  assert.match(card.payload.text, /Host: <b>[^<]+<\/b> \(local\)/);
  assert.match(card.payload.text, /Agent: <b>Claude<\/b>/);
  assert.match(card.payload.text, /Folder: <code>\/tmp\/project<\/code>/);
  assert.match(card.payload.text, /State: 💤 idle/);
  assert.equal(card.payload.message_thread_id, TOPIC);
  assert.equal(h.last("pinChatMessage").payload.message_id, h.store.get(TOPIC)!.pinnedMessageId);
  assert.equal(h.store.get(TOPIC)!.cardPinned, true);
  h.topics.state(TOPIC, "working");
  await h.topics.refresh(TOPIC);
  assert.match(h.last("editMessageText").payload.text, /State: ⏳ working/);
  assert.equal(h.calls.filter((c) => c.method === "sendMessage").length, 1);
  assert.equal(h.calls.filter((c) => c.method === "pinChatMessage").length, 1);
  const count = h.calls.length;
  await h.topics.refresh(TOPIC);
  assert.equal(h.calls.length, count, "unchanged card and title need no Telegram edits");
});

test("remote cards identify the host and use that host's model catalog", async (t) => {
  const h = fixture(t);
  h.store.update(TOPIC, { host: "bazzite", agent: "codex", cwd: "~/Code", title: "Fix <player> & tests" });
  await h.topics.refresh(TOPIC);
  const html = h.last("sendMessage").payload.text;
  assert.match(html, /Host: <b>bazzite<\/b> \(remote\)/);
  assert.match(html, /Agent: <b>Codex<\/b>/);
  assert.match(html, /Remote model/);
  assert.match(html, /Fix &lt;player&gt; &amp; tests/);
  assert.equal(h.last("editForumTopic").payload.name, "💤 Fix <player> & tests");
});

test("title summaries use bounded conversation context, update as the focus changes, and preserve current state", async (t) => {
  let finish: ((title: string) => void) | undefined;
  const h = fixture(t, async (_title, context) => {
    assert.equal(context[0]!.role, "user");
    return new Promise<string>((resolve) => { finish = resolve; });
  });
  h.topics.userMessage(TOPIC, "Fix login\nIt redirects to the wrong page.");
  assert.equal(h.store.get(TOPIC)!.title, "Fix login", "immediate fallback before the model responds");
  await until(() => !!finish);
  h.topics.state(TOPIC, "working");
  finish!("Login redirect and regression coverage");
  await until(() => h.store.get(TOPIC)!.title === "Login redirect and regression coverage");
  await h.topics.refresh(TOPIC);
  assert.equal(h.last("editForumTopic").payload.name, "⏳ Login redirect and regression coverage");
  for (let i = 0; i < 12; i++) h.topics.userMessage(TOPIC, `Follow-up ${i}: ` + "x".repeat(3000));
  const context = h.store.get(TOPIC)!.titleContext!;
  assert.equal(context.length, 8);
  assert.match(context[0]!.text, /Fix login/);
  assert.match(context.at(-1)!.text, /Follow-up 11/);
  assert.ok(context.every((entry) => entry.text.length <= 1800));
});

test("stale and cancelled title summaries cannot overwrite a newer conversation or ended session", async (t) => {
  const pending: { resolve: (title: string) => void; signal: AbortSignal }[] = [];
  const h = fixture(t, async (_title, _context, signal) => new Promise<string>((resolve) => pending.push({ resolve, signal })));
  h.topics.userMessage(TOPIC, "Fix login");
  await until(() => pending.length === 1);
  h.topics.userMessage(TOPIC, "Now port the video player");
  assert.equal(pending[0]!.signal.aborted, true);
  pending[0]!.resolve("Stale login summary");
  await until(() => pending.length === 2);
  assert.notEqual(h.store.get(TOPIC)!.title, "Stale login summary");
  h.store.update(TOPIC, { closed: true });
  h.topics.state(TOPIC, "ended");
  pending[1]!.resolve("Obsolete player summary");
  await h.topics.refresh(TOPIC);
  await delay(5);
  assert.notEqual(h.store.get(TOPIC)!.title, "Obsolete player summary");
  assert.equal(h.last("editForumTopic").payload.name, "⏹ Fix login");
});

test("summary failures leave the fallback and lifecycle usable", async (t) => {
  let attempted = false;
  const h = fixture(t, async () => { attempted = true; throw new Error("offline"); });
  h.topics.userMessage(TOPIC, "Fix the upload timeout");
  await until(() => attempted);
  h.topics.state(TOPIC, "ready");
  await h.topics.refresh(TOPIC);
  assert.equal(h.last("editForumTopic").payload.name, "✅ Fix the upload timeout");
});

test("restart reuses persisted cards, recovers working as idle, and leaves closed topics alone", async (t) => {
  const h = fixture(t);
  await h.topics.refresh(TOPIC);
  h.store.update(TOPIC, { activity: "working" });
  h.store.upsert({ topicId: 99, agent: "codex", project: "p", cwd: "/tmp", title: "Closed", closed: true });
  const topics = new SessionTopics(h.cfg, h.api, h.store, h.models, async (title) => title);
  t.after(() => topics.shutdown());
  await topics.restore();
  assert.equal(h.store.get(TOPIC)!.activity, "idle");
  assert.equal(h.calls.filter((c) => c.method === "sendMessage").length, 1);
  assert.equal(h.calls.filter((c) => c.method === "pinChatMessage").length, 1);
  assert.ok(h.calls.every((c) => c.payload.message_thread_id !== 99));
});

test("deleted cards are replaced and pin failures do not block session updates", async (t) => {
  const h = fixture(t);
  h.failures.set("pinChatMessage", new Error("missing rights"));
  await h.topics.refresh(TOPIC);
  assert.equal(h.store.get(TOPIC)!.cardPinned, false);
  await h.topics.refresh(TOPIC);
  assert.equal(h.store.get(TOPIC)!.cardPinned, true);
  const oldId = h.store.get(TOPIC)!.pinnedMessageId;
  h.failures.set("editMessageText", new Error("message to edit not found"));
  h.topics.state(TOPIC, "working");
  await h.topics.refresh(TOPIC);
  assert.notEqual(h.store.get(TOPIC)!.pinnedMessageId, oldId);
  assert.equal(h.store.get(TOPIC)!.cardPinned, true);
});

test("a prompt arriving during restart recovery keeps its new working state", async (t) => {
  const h = fixture(t);
  h.store.update(TOPIC, { activity: "working" });
  h.store.upsert({ topicId: 8, agent: "claude", project: "p", cwd: "/tmp", title: "Other task", activity: "working" });
  const nextTopic = h.store.list()[1]!.topicId;
  let release: () => void;
  let first = true;
  h.models.label = async () => {
    if (first) { first = false; await new Promise<void>((resolve) => { release = resolve; }); }
    return "Model";
  };
  const restoring = h.topics.restore();
  await until(() => !first);
  h.topics.state(nextTopic, "working");
  release!();
  await restoring;
  assert.equal(h.store.get(nextTopic)!.activity, "working");
});

test("session lifecycle updates status for work, replies, approvals, stop, failure, and end", async (t) => {
  const h = fixture(t);
  let events: AgentEvents;
  const answers: ((decision: PermissionDecision) => void)[] = [];
  const permissions = {
    request: () => new Promise<PermissionDecision>((resolve) => { answers.push(resolve); }),
    denyAll: async () => undefined,
  } as unknown as PermissionBroker;
  const agent: AgentSession = {
    kind: "claude", busy: false,
    send: () => { events.sessionId("remote-session"); events.turnStarted(); },
    interrupt: async () => events.turnEnded({ interrupted: true }),
    close: async () => events.turnEnded({ error: "closed" }),
    setModel: async () => undefined, setEffort: async () => undefined,
  };
  const hosts = {
    session: (_host: string, _kind: string, _init: unknown, sink: AgentEvents) => { events = sink; return agent; },
    shutdown: () => undefined,
  } as unknown as HostRegistry;
  const manager = new SessionManager(h.cfg, h.api, h.store, permissions, hosts, h.topics);
  manager.create(TOPIC, "claude", { name: "p", path: "~/Code" }, "New session", true, "remote");
  manager.send(TOPIC, "Fix login");
  assert.equal(h.store.get(TOPIC)!.activity, "working");
  events!.reply("The login redirect is fixed.", true);
  events!.turnEnded({});
  assert.equal(h.store.get(TOPIC)!.activity, "ready");
  assert.deepEqual(h.store.get(TOPIC)!.titleContext!.map((entry) => entry.role), ["user", "assistant"]);
  events!.turnStarted();
  const approval = events!.askPermission({ tool: "Bash", summary: "git push", canAlwaysAllow: false, signal: new AbortController().signal });
  const secondApproval = events!.askPermission({ tool: "Write", summary: "file", canAlwaysAllow: false, signal: new AbortController().signal });
  assert.equal(h.store.get(TOPIC)!.activity, "idle");
  answers[0]!("allow");
  await approval;
  assert.equal(h.store.get(TOPIC)!.activity, "idle", "another approval is still pending");
  answers[1]!("deny");
  await secondApproval;
  assert.equal(h.store.get(TOPIC)!.activity, "working");
  events!.turnEnded({ interrupted: true });
  assert.equal(h.store.get(TOPIC)!.activity, "idle");
  events!.turnStarted();
  events!.turnEnded({ error: "connection dropped" });
  assert.equal(h.store.get(TOPIC)!.activity, "idle");
  await manager.end(TOPIC);
  assert.equal(h.store.get(TOPIC)!.activity, "ended");
  events!.turnStarted();
  events!.turnEnded({});
  assert.equal(h.store.get(TOPIC)!.activity, "ended", "late SDK events cannot revive a disposed session");
});

test("a Telegram rate limit retries the topic after the wait instead of dropping it", async (t) => {
  const { topics, calls, failures, store } = fixture(t);
  store.upsert({ topicId: 8, agent: "claude", project: "p", cwd: "/tmp/other", title: "Other session" });
  const tooMany = new GrammyError(
    "Call to 'editForumTopic' failed! (429: Too Many Requests: retry after 1)",
    { ok: false, error_code: 429, description: "Too Many Requests: retry after 1", parameters: { retry_after: 0.05 } },
    "editForumTopic",
    {},
  );
  failures.set("editForumTopic", tooMany);
  await topics.refresh(TOPIC);
  // The limit stops this update before the card, and holds back other topics while it lasts.
  assert.equal(calls.filter((c) => c.method === "sendMessage").length, 0);
  await topics.refresh(8);
  assert.equal(calls.filter((c) => c.method === "editForumTopic").length, 1);

  await until(() => calls.filter((c) => c.method === "sendMessage").length === 2);
  const renamed = calls.filter((c) => c.method === "editForumTopic").map((c) => c.payload.message_thread_id).sort();
  assert.deepEqual(renamed, [TOPIC, TOPIC, 8]);
  assert.ok(store.get(TOPIC)!.pinnedMessageId);
  assert.ok(store.get(8)!.pinnedMessageId);
});
