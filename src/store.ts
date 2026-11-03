import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import type { AgentKind } from "./agents/types.js";

/** One Telegram topic ↔ one agent session. */
export interface SessionRecord {
  topicId: number;
  agent: AgentKind;
  project: string;
  cwd: string;
  title: string;
  /** Claude session id / Codex thread id, known after the first turn starts. */
  sessionId?: string;
  createdAt: string;
  updatedAt: string;
  closed?: boolean;
  /** Title is a placeholder; rename the topic after the first message. */
  autoTitle?: boolean;
  /** Model picked in Telegram for this session; unset: the configured default. */
  model?: string;
  /** Reasoning effort picked in Telegram for this session; unset: the configured default. */
  effort?: string;
}

/**
 * Topic → session mapping, persisted as one JSON file. The agents keep their
 * own transcripts on disk (~/.claude/projects, ~/.codex/sessions), so this is
 * all the gateway needs to resume after a restart.
 */
export class SessionStore {
  private readonly file: string;
  private readonly records = new Map<number, SessionRecord>();

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, "sessions.json");
    if (existsSync(this.file)) {
      const list = JSON.parse(readFileSync(this.file, "utf8")) as SessionRecord[];
      for (const r of list) this.records.set(r.topicId, r);
    }
  }

  get(topicId: number): SessionRecord | undefined {
    return this.records.get(topicId);
  }

  list(): SessionRecord[] {
    return [...this.records.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  upsert(record: Omit<SessionRecord, "createdAt" | "updatedAt"> & Partial<Pick<SessionRecord, "createdAt">>): SessionRecord {
    const now = new Date().toISOString();
    const prev = this.records.get(record.topicId);
    const next: SessionRecord = { ...prev, ...record, createdAt: prev?.createdAt ?? record.createdAt ?? now, updatedAt: now };
    this.records.set(next.topicId, next);
    this.save();
    return next;
  }

  update(topicId: number, patch: Partial<Omit<SessionRecord, "topicId">>): SessionRecord | undefined {
    const prev = this.records.get(topicId);
    if (!prev) return undefined;
    return this.upsert({ ...prev, ...patch });
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify([...this.records.values()], null, 2));
    renameSync(tmp, this.file); // atomic replace
  }
}
