import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { PermissionMode, EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import type { ModelReasoningEffort, SandboxMode } from "@openai/codex-sdk";

export interface Project {
  name: string;
  path: string;
}

export interface Config {
  telegram: {
    token: string;
    /** The forum supergroup (Topics on) the bot works in. Unset: setup mode. */
    chatId?: number;
    /** Only these Telegram users can talk to the bot. Empty: setup mode. */
    allowedUserIds: Set<number>;
  };
  /** Chat or users not configured yet: the bot only answers /whoami. */
  setupMode: boolean;
  projects: Project[];
  dataDir: string;
  claude: {
    model?: string;
    effort?: EffortLevel;
    permissionMode: PermissionMode;
    executable?: string;
  };
  codex: {
    model?: string;
    reasoningEffort?: ModelReasoningEffort;
    sandboxMode: SandboxMode;
    networkAccess: boolean;
    executable?: string;
  };
}

const expandHome = (p: string) => (p === "~" || p.startsWith("~/") ? path.join(homedir(), p.slice(1)) : p);

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing required environment variable ${name} (see .env.example)`);
  return v;
}

function optional(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

function oneOf<T extends string>(name: string, allowed: readonly T[], fallback: T): T;
function oneOf<T extends string>(name: string, allowed: readonly T[]): T | undefined;
function oneOf<T extends string>(name: string, allowed: readonly T[], fallback?: T): T | undefined {
  const v = optional(name);
  if (v === undefined) return fallback;
  if (!(allowed as readonly string[]).includes(v)) {
    throw new Error(`${name}=${v} is not one of: ${allowed.join(", ")}`);
  }
  return v as T;
}

function loadProjects(file: string): Project[] {
  if (!existsSync(file)) {
    throw new Error(`Projects file not found: ${file} (copy projects.example.json to projects.json)`);
  }
  const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`${file} must be a non-empty array of { "name", "path" }`);
  }
  const projects = raw.map((p, i) => {
    if (typeof p?.name !== "string" || typeof p?.path !== "string") {
      throw new Error(`${file}[${i}] needs string "name" and "path"`);
    }
    const resolved = path.resolve(expandHome(p.path));
    if (!existsSync(resolved)) throw new Error(`${file}[${i}] path does not exist: ${resolved}`);
    // Real path, so the agents' absolute paths can be shown relative to it.
    return { name: p.name, path: realpathSync(resolved) };
  });
  const names = new Set<string>();
  for (const p of projects) {
    if (names.has(p.name)) throw new Error(`${file}: duplicate project name "${p.name}"`);
    names.add(p.name);
  }
  return projects;
}

export function loadConfig(): Config {
  if (existsSync(".env")) process.loadEnvFile(".env");

  const rawChat = optional("TELEGRAM_CHAT_ID");
  const chatId = rawChat === undefined ? undefined : Number(rawChat);
  if (chatId !== undefined && (!Number.isInteger(chatId) || chatId >= 0)) {
    throw new Error("TELEGRAM_CHAT_ID must be the forum supergroup id (a negative number like -100…)");
  }
  const allowedUserIds = new Set(
    (optional("TELEGRAM_ALLOWED_USER_IDS") ?? "").split(",").filter((s) => s.trim()).map((s) => {
      const id = Number(s.trim());
      if (!Number.isInteger(id) || id <= 0) throw new Error(`Bad user id in TELEGRAM_ALLOWED_USER_IDS: "${s}"`);
      return id;
    }),
  );

  return {
    telegram: { token: required("TELEGRAM_BOT_TOKEN"), chatId, allowedUserIds },
    setupMode: chatId === undefined || allowedUserIds.size === 0,
    projects: loadProjects(path.resolve(optional("PROJECTS_FILE") ?? "projects.json")),
    dataDir: path.resolve(expandHome(optional("DATA_DIR") ?? "data")),
    claude: {
      model: optional("CLAUDE_MODEL"),
      effort: oneOf("CLAUDE_EFFORT", ["low", "medium", "high", "xhigh", "max"] as const),
      permissionMode: oneOf("CLAUDE_PERMISSION_MODE", ["default", "acceptEdits", "plan", "dontAsk", "auto", "bypassPermissions"] as const, "default"),
      executable: optional("CLAUDE_PATH"),
    },
    codex: {
      model: optional("CODEX_MODEL"),
      reasoningEffort: oneOf("CODEX_REASONING_EFFORT", ["minimal", "low", "medium", "high", "xhigh"] as const),
      sandboxMode: oneOf("CODEX_SANDBOX", ["read-only", "workspace-write", "danger-full-access"] as const, "workspace-write"),
      networkAccess: optional("CODEX_NETWORK_ACCESS") === "true",
      executable: optional("CODEX_PATH"),
    },
  };
}
