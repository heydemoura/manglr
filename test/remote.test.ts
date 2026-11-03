import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import type { AgentEvents, AgentSession, PermissionDecision, PermissionRequest } from "../src/agents/types.js";
import { DEFAULT_RUNNER_COMMAND, loadHosts, type HostConfig } from "../src/hosts.js";
import { RemoteHost, type RunnerProcess } from "../src/remote/host.js";
import type { SessionSpec } from "../src/remote/protocol.js";
import { RunnerCore, type RunnerDeps } from "../src/remote/runner-core.js";

const HOST: HostConfig = { name: "box", ssh: "me@box", cwd: "~", command: DEFAULT_RUNNER_COMMAND };

/**
 * A fake agent: each message is one turn that asks permission for "Bash",
 * then answers with the decision.
 */
class EchoSession implements AgentSession {
  busy = false;
  closed = false;
  constructor(
    readonly kind: "claude" | "codex",
    private readonly events: AgentEvents,
    private readonly id: string,
  ) {}
  send(text: string): void {
    if (this.closed) throw new Error("session is closed");
    this.busy = true;
    this.events.turnStarted();
    this.events.sessionId(this.id);
    this.events.progress(`💻 echo ${text}`);
    const abort = new AbortController();
    void this.events
      .askPermission({ tool: "Bash", summary: `echo ${text}`, canAlwaysAllow: true, signal: abort.signal })
      .then((d) => {
        this.events.reply(`${text} (${d})`, true);
        this.busy = false;
        this.events.turnEnded({ costUsd: 0.01 });
      });
  }
  async setModel(): Promise<void> {}
  async setEffort(): Promise<void> {}
  async interrupt(): Promise<void> {}
  async close(): Promise<void> {
    this.closed = true;
  }
}

/** A hub wired to RunnerCores in memory: each "SSH connection" is a fresh runner. */
function wire() {
  const opened: { spec: SessionSpec; cwd: string }[] = [];
  const runners: { kill: () => void }[] = [];
  const deps: RunnerDeps = {
    hostname: "box",
    home: tmpdir(),
    makeSession: (spec, cwd, events) => {
      opened.push({ spec, cwd });
      return new EchoSession(spec.kind, events, spec.resume ?? "sess-1");
    },
    listModels: async (agent, spec) => [{ value: "", label: "Default", description: `${agent} in ${spec.cwd}` }],
  };
  const spawner = (): RunnerProcess => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = new EventEmitter() as EventEmitter & RunnerProcess;
    let dead = false;
    const kill = () => {
      if (dead) return;
      dead = true;
      stdout.end();
      child.emit("exit", null, "SIGTERM");
    };
    Object.assign(child, { stdin, stdout, stderr, kill });
    const core = new RunnerCore((msg) => {
      if (!dead) stdout.write(`${JSON.stringify(msg)}\n`);
    }, deps);
    createInterface({ input: stdin }).on("line", (line) => void core.handle(line));
    stdout.write("Welcome to box! (shell noise is ignored)\n");
    core.hello();
    runners.push({ kill });
    return child;
  };
  return { host: new RemoteHost(HOST, spawner), opened, runners };
}

/** Records what a remote session reports, answering permissions with `decision`. */
function recorder(decision: PermissionDecision = "allow") {
  const log: string[] = [];
  const asks: PermissionRequest[] = [];
  let ended!: () => void;
  let turnDone = new Promise<void>((r) => (ended = r));
  const events: AgentEvents = {
    sessionId: (id) => void log.push(`id ${id}`),
    turnStarted: () => void log.push("started"),
    progress: (line) => void log.push(`progress ${line}`),
    reply: (text, final) => void log.push(`${final ? "final" : "reply"} ${text}`),
    turnEnded: (info) => {
      log.push(info.error ? `ended: ${info.error}` : "ended");
      ended();
      turnDone = new Promise<void>((r) => (ended = r));
    },
    askPermission: async (req) => {
      asks.push(req);
      log.push(`ask ${req.tool}: ${req.summary}`);
      return decision;
    },
  };
  return { events, log, asks, nextTurn: () => turnDone };
}

const spec = { kind: "claude" as const, cwd: "~", claude: { permissionMode: "default" as const }, codex: { sandboxMode: "workspace-write" as const, networkAccess: false } };

test("a remote turn relays events and permission answers both ways", async () => {
  const { host, opened } = wire();
  const r = recorder("always");
  const session = host.session(spec, { model: "sonnet" }, r.events);
  const done = r.nextTurn();
  session.send("hi");
  assert.equal(session.busy, true, "busy as soon as the message is sent");
  await done;
  assert.deepEqual(r.log, ["started", "id sess-1", "progress 💻 echo hi", "ask Bash: echo hi", "final hi (always)", "ended"]);
  assert.equal(session.busy, false);
  assert.equal(r.asks[0]!.canAlwaysAllow, true);
  // The runner got the session's settings and resolved ~ to its own home.
  assert.equal(opened.length, 1);
  assert.equal(opened[0]!.spec.model, "sonnet");
  assert.equal(opened[0]!.cwd, realpathSync(tmpdir()));
  host.shutdown();
});

test("a dropped connection fails the turn; the next message reconnects and resumes", async () => {
  const { host, opened, runners } = wire();
  const r = recorder();
  // Permission is never answered, so the turn is still running when the link drops.
  r.events.askPermission = (req) => new Promise((resolve) => req.signal.addEventListener("abort", () => resolve("deny")));
  const session = host.session(spec, {}, r.events);
  let done = r.nextTurn();
  session.send("one");
  await new Promise((res) => setTimeout(res, 20));
  runners[0]!.kill();
  await done;
  assert.match(r.log.at(-1)!, /^ended: lost connection to box/);
  assert.equal(session.busy, false);

  r.events.askPermission = async () => "allow";
  done = r.nextTurn();
  session.send("two");
  await done;
  assert.equal(r.log.at(-1), "ended");
  assert.equal(opened.length, 2, "opened again on the new connection");
  assert.equal(opened[1]!.spec.resume, "sess-1", "resumes the agent's session");
  host.shutdown();
});

test("models come from the runner; an unreachable host fails the turn with the reason", async () => {
  const { host } = wire();
  assert.deepEqual(await host.listModels("codex", { cwd: "~/x", claude: {}, codex: {} }), [
    { value: "", label: "Default", description: "codex in ~/x" },
  ]);
  host.shutdown();

  const broken = new RemoteHost(HOST, () => {
    const child = new EventEmitter() as EventEmitter & RunnerProcess;
    const stderr = new PassThrough();
    Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr, kill: () => undefined });
    setTimeout(() => {
      stderr.write("me@box: Permission denied (publickey).\n");
      setTimeout(() => child.emit("exit", 255, null), 10);
    }, 5);
    return child;
  });
  const r = recorder();
  const done = r.nextTurn();
  broken.session(spec, {}, r.events).send("hi");
  await done;
  assert.deepEqual(r.log.slice(0, 1), ["started"]);
  assert.match(r.log[1]!, /could not reach box: runner exited with code 255: me@box: Permission denied/);
});

test("a missing folder on the remote host is reported, not crashed on", async () => {
  const { host } = wire();
  const r = recorder();
  const done = r.nextTurn();
  host.session({ ...spec, cwd: "/definitely/not/here" }, {}, r.events).send("hi");
  await done;
  assert.match(r.log.at(-1)!, /folder not found on box: \/definitely\/not\/here/);
  host.shutdown();
});

test("hosts file: defaults, validation", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "manglr-hosts-"));
  const file = path.join(dir, "hosts.json");
  assert.deepEqual(loadHosts(file), [], "no file: no hosts");

  writeFileSync(file, JSON.stringify([{ name: "bazzite", ssh: "bazzite@192.168.0.146" }, { name: "debian", cwd: "~/Code" }]));
  assert.deepEqual(loadHosts(file), [
    { name: "bazzite", ssh: "bazzite@192.168.0.146", cwd: "~", command: DEFAULT_RUNNER_COMMAND, claudePath: undefined, codexPath: undefined },
    { name: "debian", ssh: "debian", cwd: "~/Code", command: DEFAULT_RUNNER_COMMAND, claudePath: undefined, codexPath: undefined },
  ]);

  for (const [bad, why] of [
    [{ hosts: [] }, /JSON array/],
    [[{ ssh: "x" }], /needs a "name"/],
    [[{ name: "has space" }], /needs a "name"/],
    [[{ name: "local" }], /reserved/],
    [[{ name: "a" }, { name: "a" }], /listed twice/],
    [[{ name: "a", cwd: 3 }], /bad "cwd"/],
  ] as const) {
    writeFileSync(file, JSON.stringify(bad));
    assert.throws(() => loadHosts(file), why);
  }
});
