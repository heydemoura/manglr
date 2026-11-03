import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { AgentEvents, AgentKind, AgentSession, PermissionDecision } from "../agents/types.js";
import type { HostConfig } from "../hosts.js";
import type { ModelChoice } from "../models.js";
import { log } from "../util/log.js";
import { PROTOCOL_VERSION, type CatalogSpec, type HubMessage, type RunnerMessage, type SessionSpec } from "./protocol.js";

/** What the hub needs from the process carrying the protocol (an `ssh` child in practice). */
export interface RunnerProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  kill(): void;
  once(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown;
  once(event: "error", listener: (err: Error) => void): unknown;
}

export type Spawner = (host: HostConfig) => RunnerProcess;

/** `ssh host '<command>'`, without a terminal, failing instead of prompting. */
export const sshSpawner: Spawner = (host) =>
  spawn(
    "ssh",
    [
      "-T",
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=10",
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=4",
      host.ssh,
      host.command,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );

const READY_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 90_000;

type HubRequest = HubMessage extends infer M ? (M extends { rid: number } ? Omit<M, "rid"> : never) : never;

interface Connection {
  child: RunnerProcess;
  alive: boolean;
  /** We hung up on purpose: the exit is not news. */
  closing?: boolean;
  pending: Map<number, { resolve: (v: ModelChoice[] | undefined) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>;
  sessions: Map<string, RemoteSession>;
  /** Last stderr lines, to explain a failed connection. */
  stderr: string[];
}

/**
 * One remote computer. The SSH connection to its runner opens on first use
 * and is shared by every session there; if it drops, running turns fail and
 * the next message reconnects and resumes the session from its transcript.
 */
export class RemoteHost {
  private current?: { conn: Connection; ready: Promise<Connection> };
  private rid = 0;

  constructor(
    readonly cfg: HostConfig,
    private readonly spawner: Spawner = sshSpawner,
  ) {}

  get name(): string {
    return this.cfg.name;
  }

  /** A session on this host; nothing happens remotely until its first message. */
  session(spec: Omit<SessionSpec, "resume" | "model" | "effort">, init: { resume?: string; model?: string; effort?: string }, events: AgentEvents): AgentSession {
    return new RemoteSession(this, spec, init, events);
  }

  async listModels(agent: AgentKind, spec: CatalogSpec): Promise<ModelChoice[]> {
    const conn = await this.connection();
    return (await this.request(conn, { t: "models", agent, spec })) ?? [];
  }

  /** Drop the connection; the runner ends its sessions (transcripts stay). */
  shutdown(): void {
    const conn = this.current?.conn;
    this.current = undefined;
    if (conn?.alive) {
      conn.closing = true;
      conn.child.kill();
    }
  }

  /** @internal */
  connection(): Promise<Connection> {
    if (!this.current) this.current = this.connect();
    return this.current.ready;
  }

  /** @internal */
  post(conn: Connection, msg: HubMessage): void {
    if (!conn.alive) throw new Error(`not connected to ${this.name}`);
    conn.child.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  /** @internal */
  request(conn: Connection, msg: HubRequest, timeoutMs = REQUEST_TIMEOUT_MS): Promise<ModelChoice[] | undefined> {
    const rid = ++this.rid;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(rid);
        reject(new Error(`${this.name} did not answer ${msg.t} in ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      conn.pending.set(rid, { resolve, reject, timer });
      try {
        this.post(conn, { ...msg, rid } as HubMessage);
      } catch (err) {
        clearTimeout(timer);
        conn.pending.delete(rid);
        reject(err);
      }
    });
  }

  private connect(): { conn: Connection; ready: Promise<Connection> } {
    log.info(`connecting to ${this.name} (${this.cfg.ssh})`);
    const child = this.spawner(this.cfg);
    const conn: Connection = { child, alive: true, pending: new Map(), sessions: new Map(), stderr: [] };
    let settle!: { resolve: (c: Connection) => void; reject: (e: Error) => void };
    let isReady = false;
    const ready = new Promise<Connection>((resolve, reject) => (settle = { resolve, reject }));
    ready.catch(() => undefined); // handled by whoever awaits it
    const timer = setTimeout(() => fail(`no answer from the runner in ${READY_TIMEOUT_MS / 1000}s`), READY_TIMEOUT_MS);

    const fail = (reason: string) => {
      if (!conn.alive) return;
      conn.alive = false;
      clearTimeout(timer);
      if (this.current?.conn === conn) this.current = undefined;
      // Before the handshake, stderr is ssh or the shell explaining what went wrong.
      const detail = isReady ? undefined : conn.stderr.filter((l) => l.trim()).at(-1);
      const why = `${reason}${detail ? `: ${detail}` : ""}`;
      if (conn.closing) log.debug(`${this.name}: disconnected`);
      else log.warn(`${this.name}: ${why}`);
      if (!isReady) settle.reject(new Error(`could not reach ${this.name}: ${why}`));
      for (const p of conn.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(`lost connection to ${this.name}`));
      }
      conn.pending.clear();
      for (const s of conn.sessions.values()) s.connectionLost(`lost connection to ${this.name}: ${why}`);
      conn.sessions.clear();
      child.kill();
    };

    createInterface({ input: child.stderr, crlfDelay: Infinity }).on("line", (line) => {
      conn.stderr.push(line);
      if (conn.stderr.length > 20) conn.stderr.shift();
      log.debug(`[${this.name}] ${line}`);
    });
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
      let msg: RunnerMessage;
      try {
        msg = JSON.parse(line) as RunnerMessage;
      } catch {
        // Shell startup files sometimes print; anything that isn't protocol is ignored.
        log.debug(`[${this.name}] (not protocol) ${line}`);
        return;
      }
      if (msg.t === "ready") {
        if (msg.protocol !== PROTOCOL_VERSION) {
          return fail(`runner speaks protocol ${msg.protocol}, this gateway ${PROTOCOL_VERSION}: update manglr there`);
        }
        isReady = true;
        clearTimeout(timer);
        log.info(`connected to ${this.name}: runner on ${msg.hostname}, node ${msg.node}`);
        return settle.resolve(conn);
      }
      if (msg.t === "result") {
        const p = conn.pending.get(msg.rid);
        if (!p) return;
        conn.pending.delete(msg.rid);
        clearTimeout(p.timer);
        return msg.ok ? p.resolve(msg.value) : p.reject(new Error(msg.error));
      }
      conn.sessions.get(msg.sid)?.receive(msg);
    });
    child.stdin.on("error", () => undefined); // surfaces as exit
    child.once("error", (err) => fail(err.message));
    child.once("exit", (code, signal) => fail(signal ? `runner ended (${signal})` : `runner exited with code ${code}`));
    return { conn, ready };
  }
}

/**
 * An agent session on a remote host, seen through the AgentSession
 * interface. It opens on the runner at the first message (and again after a
 * reconnect, resuming the agent's own session id), then relays events back.
 */
class RemoteSession implements AgentSession {
  readonly kind: AgentKind;
  private readonly sid = randomBytes(6).toString("base64url");
  private conn?: Connection;
  /** Serializes opening and the messages that depend on it. */
  private chain: Promise<unknown> = Promise.resolve();
  private running = false;
  /** A turnStarted reached the UI and no turnEnded yet. */
  private uiTurn = false;
  private closed = false;
  private readonly perms = new Map<string, AbortController>();
  private resume?: string;
  private model?: string;
  private effort?: string;

  constructor(
    private readonly host: RemoteHost,
    private readonly spec: Omit<SessionSpec, "resume" | "model" | "effort">,
    init: { resume?: string; model?: string; effort?: string },
    private readonly events: AgentEvents,
  ) {
    this.kind = spec.kind;
    this.resume = init.resume;
    this.model = init.model;
    this.effort = init.effort;
  }

  get busy(): boolean {
    return this.running;
  }

  send(text: string): void {
    if (this.closed) throw new Error("session is closed");
    this.running = true;
    void this.serial(async () => {
      const conn = await this.open();
      this.host.post(conn, { t: "send", sid: this.sid, text });
    }).catch((err) => this.failTurn(err));
  }

  async setModel(model: string | undefined): Promise<void> {
    this.model = model;
    await this.serial(async () => {
      if (this.conn?.alive) await this.host.request(this.conn, { t: "setModel", sid: this.sid, model });
    });
  }

  async setEffort(effort: string | undefined): Promise<void> {
    this.effort = effort;
    await this.serial(async () => {
      if (this.conn?.alive) await this.host.request(this.conn, { t: "setEffort", sid: this.sid, effort });
    });
  }

  async interrupt(): Promise<void> {
    if (this.conn?.alive && this.running) await this.host.request(this.conn, { t: "interrupt", sid: this.sid });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.cancelPermissions();
    const conn = this.conn;
    this.conn = undefined;
    if (!conn?.alive) return;
    await this.host.request(conn, { t: "close", sid: this.sid }, 10_000).catch((err) => log.debug(`close on ${this.host.name}`, String(err)));
    conn.sessions.delete(this.sid);
  }

  /** @internal A message from the runner for this session. */
  receive(msg: RunnerMessage): void {
    switch (msg.t) {
      case "event":
        switch (msg.e) {
          case "sessionId":
            this.resume = msg.id;
            return this.events.sessionId(msg.id);
          case "turnStarted":
            this.running = true;
            this.uiTurn = true;
            return this.events.turnStarted();
          case "progress":
            return this.events.progress(msg.line);
          case "reply":
            return this.events.reply(msg.text, msg.final);
          case "turnEnded":
            this.running = false;
            this.uiTurn = false;
            return this.events.turnEnded({ error: msg.error, interrupted: msg.interrupted, costUsd: msg.costUsd });
        }
        return;
      case "askPermission": {
        const abort = new AbortController();
        this.perms.set(msg.pid, abort);
        const conn = this.conn;
        void this.events
          .askPermission({ tool: msg.tool, summary: msg.summary, reason: msg.reason, canAlwaysAllow: msg.canAlwaysAllow, signal: abort.signal })
          .catch((): PermissionDecision => "deny")
          .then((decision) => {
            if (!this.perms.delete(msg.pid) || !conn?.alive) return;
            this.host.post(conn, { t: "permission", sid: this.sid, pid: msg.pid, decision });
          });
        return;
      }
      case "permissionCancelled": {
        const abort = this.perms.get(msg.pid);
        this.perms.delete(msg.pid);
        abort?.abort();
        return;
      }
      default:
        return;
    }
  }

  /** @internal The SSH connection dropped: whatever was running is gone. */
  connectionLost(reason: string): void {
    this.conn = undefined;
    this.cancelPermissions();
    if (this.running || this.uiTurn) this.failTurn(new Error(reason));
  }

  private async open(): Promise<Connection> {
    if (this.conn?.alive) return this.conn;
    const conn = await this.host.connection();
    conn.sessions.set(this.sid, this);
    try {
      await this.host.request(conn, {
        t: "open",
        sid: this.sid,
        spec: { ...this.spec, resume: this.resume, model: this.model, effort: this.effort },
      });
    } catch (err) {
      conn.sessions.delete(this.sid);
      throw err;
    }
    this.conn = conn;
    return conn;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** End the UI's turn with an error, starting one first if none is showing. */
  private failTurn(err: unknown): void {
    const error = err instanceof Error ? err.message : String(err);
    if (!this.uiTurn) this.events.turnStarted();
    this.running = false;
    this.uiTurn = false;
    this.events.turnEnded({ error });
  }

  private cancelPermissions(): void {
    const pending = [...this.perms.values()];
    this.perms.clear();
    for (const abort of pending) abort.abort();
  }
}
