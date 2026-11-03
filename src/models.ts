import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentKind } from "./agents/types.js";
import type { Config } from "./config.js";
import { AsyncQueue } from "./util/async-queue.js";
import { log } from "./util/log.js";

export interface ModelChoice {
  /** What the agent is started with; "" is the default (no per-session override). */
  value: string;
  label: string;
  description?: string;
}

const TTL_MS = 60 * 60 * 1000;

/**
 * The models each agent offers, read from the agent itself so the menu
 * follows whatever the installed CLI and account support:
 * - Claude: `supportedModels()` from a short-lived Claude Code process.
 * - Codex: the model list the Codex CLI caches in `$CODEX_HOME/models_cache.json`.
 * The first choice is always the default, which is the env model
 * (CLAUDE_MODEL / CODEX_MODEL) when set, else the agent's own default.
 */
export class ModelCatalog {
  private readonly cache = new Map<AgentKind, { at: number; models: Promise<ModelChoice[]> }>();

  constructor(private readonly cfg: Config) {}

  list(agent: AgentKind): Promise<ModelChoice[]> {
    const hit = this.cache.get(agent);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.models;
    const models = (agent === "claude" ? this.loadClaude() : Promise.resolve(this.loadCodex())).catch((err) => {
      log.warn(`could not list ${agent} models`, String(err));
      this.cache.delete(agent); // retry next time
      return [this.defaultChoice(agent)];
    });
    this.cache.set(agent, { at: Date.now(), models });
    return models;
  }

  /** Human label for a session's model ("" / undefined: the default). */
  async label(agent: AgentKind, value: string | undefined): Promise<string> {
    const models = await this.list(agent);
    const hit = models.find((m) => m.value === (value ?? ""));
    if (hit) return value ? hit.label : `${hit.label}${hit.description ? ` (${hit.description})` : ""}`;
    return value ?? "Default";
  }

  /** What "Default" resolves to on this host, e.g. "Opus 5.5" or "gpt-6.1-sol". */
  async defaultName(agent: AgentKind): Promise<string> {
    const def = (await this.list(agent)).find((m) => m.value === "");
    return def?.description ?? "the agent's default model";
  }

  private defaultChoice(agent: AgentKind, description?: string): ModelChoice {
    const env = agent === "claude" ? this.cfg.claude.model : this.cfg.codex.model;
    return { value: "", label: "Default", description: env ?? description };
  }

  private async loadClaude(): Promise<ModelChoice[]> {
    // No prompt is sent: the process starts, answers the control request and exits.
    const input = new AsyncQueue<SDKUserMessage>();
    const q = query({
      prompt: input,
      options: {
        cwd: this.cfg.workdir.path,
        pathToClaudeCodeExecutable: this.cfg.claude.executable,
      },
    });
    try {
      const rows = await q.supportedModels();
      const def = rows.find((r) => r.value === "default");
      return [
        this.defaultChoice("claude", def?.description.split(" · ")[0]),
        ...rows.filter((r) => r.value !== "default").map((r) => ({ value: r.value, label: r.displayName, description: r.description })),
      ];
    } finally {
      input.end();
      q.close();
    }
  }

  private loadCodex(): ModelChoice[] {
    const home = process.env.CODEX_HOME ?? path.join(homedir(), ".codex");
    const def = this.defaultChoice("codex", readCodexConfigModel(path.join(home, "config.toml")));
    const file = path.join(home, "models_cache.json");
    if (!existsSync(file)) return [def];
    const raw = JSON.parse(readFileSync(file, "utf8")) as { models?: unknown };
    const rows = Array.isArray(raw.models) ? (raw.models as CodexModelRow[]) : [];
    const models = rows
      .filter((m) => typeof m.slug === "string" && m.visibility === "list")
      .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
      .map((m) => ({ value: m.slug, label: m.display_name ?? m.slug, description: m.description }));
    return [def, ...models];
  }
}

interface CodexModelRow {
  slug: string;
  display_name?: string;
  description?: string;
  visibility?: string;
  priority?: number;
}

/** The top-level `model = "…"` in Codex's config.toml, for showing what "Default" means. */
function readCodexConfigModel(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim().startsWith("[")) break; // only top-level keys
    const m = /^\s*model\s*=\s*"([^"]+)"/.exec(line);
    if (m) return m[1];
  }
  return undefined;
}
