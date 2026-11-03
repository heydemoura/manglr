import { existsSync, realpathSync } from "node:fs";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { ClaudeSession } from "../agents/claude.js";
import { CodexSession } from "../agents/codex.js";
import type { AgentEvents, AgentKind, AgentSession, PermissionDecision } from "../agents/types.js";
import { ModelCatalog, type ModelChoice } from "../models.js";
import { log } from "../util/log.js";
import { PROTOCOL_VERSION, type CatalogSpec, type HubMessage, type RunnerMessage, type SessionSpec } from "./protocol.js";

export interface RunnerDeps {
  hostname: string;
  home: string;
  /** Start an agent session in `cwd` (already resolved and checked). */
  makeSession(spec: SessionSpec, cwd: string, events: AgentEvents): AgentSession;
  listModels(agent: AgentKind, spec: CatalogSpec, cwd: string): Promise<ModelChoice[]>;
}

export const defaultRunnerDeps: RunnerDeps = {
  hostname: hostname(),
  home: homedir(),
  makeSession: (spec, cwd, events) => {
    const init = { cwd, resume: spec.resume, model: spec.model, effort: spec.effort };
    return spec.kind === "claude"
      ? new ClaudeSession({ permissionMode: spec.claude.permissionMode, executable: spec.claude.executable }, init, events)
      : new CodexSession(
          { sandboxMode: spec.codex.sandboxMode, networkAccess: spec.codex.networkAccess, executable: spec.codex.executable },
          init,
          events,
        );
  },
  listModels: (agent, spec, cwd) => new ModelCatalog({ workdir: { path: cwd }, claude: spec.claude, codex: spec.codex }).list(agent),
};

interface Hosted {
  session: AgentSession;
  /** Permission requests waiting for the hub, by pid. */
  perms: Map<string, (d: PermissionDecision) => void>;
}

/**
 * The runner's side of the protocol: hosts agent sessions on this machine
 * for a hub that talks to it over stdin/stdout. Transport-free, so tests can
 * wire it to a hub in memory.
 */
export class RunnerCore {
  private readonly sessions = new Map<string, Hosted>();
  private pidSeq = 0;

  constructor(
    private readonly write: (msg: RunnerMessage) => void,
    private readonly deps: RunnerDeps = defaultRunnerDeps,
  ) {}

  hello(): void {
    this.write({ t: "ready", protocol: PROTOCOL_VERSION, hostname: this.deps.hostname, home: this.deps.home, node: process.version });
  }

  async handle(line: string): Promise<void> {
    if (!line.trim()) return;
    let msg: HubMessage;
    try {
      msg = JSON.parse(line) as HubMessage;
    } catch {
      log.warn(`runner: ignoring a line that isn't JSON: ${line.slice(0, 120)}`);
      return;
    }
    const rid = "rid" in msg ? msg.rid : undefined;
    try {
      switch (msg.t) {
        case "open":
          this.open(msg.sid, msg.spec);
          return this.ok(msg.rid);
        case "send":
          return this.send(msg.sid, msg.text);
        case "setModel":
          await this.get(msg.sid).session.setModel(msg.model);
          return this.ok(msg.rid);
        case "setEffort":
          await this.get(msg.sid).session.setEffort(msg.effort);
          return this.ok(msg.rid);
        case "interrupt":
          await this.get(msg.sid).session.interrupt();
          return this.ok(msg.rid);
        case "close":
          await this.close(msg.sid);
          return this.ok(msg.rid);
        case "permission":
          this.sessions.get(msg.sid)?.perms.get(msg.pid)?.(msg.decision);
          return;
        case "models":
          return this.write({ t: "result", rid: msg.rid, ok: true, value: await this.deps.listModels(msg.agent, msg.spec, this.resolve(msg.spec.cwd)) });
        default:
          log.warn(`runner: unknown message ${(msg as { t?: unknown }).t}`);
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (rid !== undefined) this.write({ t: "result", rid, ok: false, error });
      else log.warn(`runner: ${msg.t} failed`, error);
    }
  }

  /** The hub went away: end every session (transcripts stay on disk). */
  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((sid) => this.close(sid).catch(() => undefined)));
  }

  private ok(rid: number): void {
    this.write({ t: "result", rid, ok: true });
  }

  private get(sid: string): Hosted {
    const hosted = this.sessions.get(sid);
    if (!hosted) throw new Error(`no session ${sid} on ${this.deps.hostname}`);
    return hosted;
  }

  /** `~` is this user's home; relative paths start there too. */
  private resolve(cwd: string): string {
    const expanded = cwd === "~" || cwd.startsWith("~/") ? path.join(this.deps.home, cwd.slice(1)) : cwd;
    return path.resolve(this.deps.home, expanded);
  }

  private open(sid: string, spec: SessionSpec): void {
    if (this.sessions.has(sid)) throw new Error(`session ${sid} is already open`);
    const wanted = this.resolve(spec.cwd);
    if (!existsSync(wanted)) throw new Error(`folder not found on ${this.deps.hostname}: ${wanted}`);
    // Real path, so the agents' absolute paths show relative to it (e.g. /home → /var/home).
    const cwd = realpathSync(wanted);
    const perms = new Map<string, (d: PermissionDecision) => void>();
    const emit = (msg: RunnerMessage) => this.write(msg);
    const events: AgentEvents = {
      sessionId: (id) => emit({ t: "event", sid, e: "sessionId", id }),
      turnStarted: () => emit({ t: "event", sid, e: "turnStarted" }),
      progress: (line) => emit({ t: "event", sid, e: "progress", line }),
      reply: (text, final) => emit({ t: "event", sid, e: "reply", text, final }),
      turnEnded: (info) => emit({ t: "event", sid, e: "turnEnded", ...info }),
      askPermission: (req) =>
        new Promise<PermissionDecision>((resolve) => {
          if (req.signal.aborted) return resolve("deny");
          const pid = String(++this.pidSeq);
          perms.set(pid, (d) => {
            perms.delete(pid);
            resolve(d);
          });
          req.signal.addEventListener(
            "abort",
            () => {
              if (!perms.delete(pid)) return;
              emit({ t: "permissionCancelled", sid, pid });
              resolve("deny");
            },
            { once: true },
          );
          emit({ t: "askPermission", sid, pid, tool: req.tool, summary: req.summary, reason: req.reason, canAlwaysAllow: req.canAlwaysAllow });
        }),
    };
    this.sessions.set(sid, { session: this.deps.makeSession(spec, cwd, events), perms });
    log.info(`runner: opened ${spec.kind} session ${sid} in ${cwd}${spec.resume ? ` (resuming ${spec.resume})` : ""}`);
  }

  private send(sid: string, text: string): void {
    try {
      this.get(sid).session.send(text);
    } catch (err) {
      // No turn ran: report one that failed, so the person sees why.
      this.write({ t: "event", sid, e: "turnStarted" });
      this.write({ t: "event", sid, e: "turnEnded", error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async close(sid: string): Promise<void> {
    const hosted = this.sessions.get(sid);
    if (!hosted) return;
    this.sessions.delete(sid);
    for (const answer of [...hosted.perms.values()]) answer("deny");
    await hosted.session.close();
  }
}
