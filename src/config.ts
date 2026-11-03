import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { PermissionMode, EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import type { ModelReasoningEffort, SandboxMode } from "@openai/codex-sdk";
import { loadHosts, type HostConfig } from "./hosts.js";

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
  /** Where every session starts. The agents can still work anywhere on the host. */
  workdir: Project;
  dataDir: string;
  /** Other computers reachable over SSH (HOSTS_FILE); empty: only this one. */
  hosts: HostConfig[];
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

/** The folder sessions start in: AGENT_CWD, default the home directory. */
function loadWorkdir(): Project {
  const resolved = path.resolve(expandHome(optional("AGENT_CWD") ?? "~"));
  if (!existsSync(resolved)) throw new Error(`AGENT_CWD does not exist: ${resolved}`);
  // Real path, so the agents' absolute paths can be shown relative to it.
  const real = realpathSync(resolved);
  const home = realpathSync(homedir());
  const name = real === home ? "~" : real.startsWith(home + path.sep) ? `~${real.slice(home.length)}` : real;
  return { name, path: real };
}

/**
 * The gateway's own settings. They are removed from process.env once read, so
 * the agents (and every command they run) don't inherit the bot token: a
 * process started by an agent must not be able to act as the bot.
 */
export const GATEWAY_ENV_KEYS = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "TELEGRAM_ALLOWED_USER_IDS",
  "AGENT_CWD",
  "DATA_DIR",
  "HOSTS_FILE",
  "CLAUDE_MODEL",
  "CLAUDE_EFFORT",
  "CLAUDE_PERMISSION_MODE",
  "CLAUDE_PATH",
  "CODEX_MODEL",
  "CODEX_REASONING_EFFORT",
  "CODEX_SANDBOX",
  "CODEX_NETWORK_ACCESS",
  "CODEX_PATH",
] as const;

export function loadConfig(): Config {
  if (existsSync(".env")) process.loadEnvFile(".env");
  try {
    return readConfig();
  } finally {
    for (const key of GATEWAY_ENV_KEYS) delete process.env[key];
  }
}

function readConfig(): Config {

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
    workdir: loadWorkdir(),
    dataDir: path.resolve(expandHome(optional("DATA_DIR") ?? "data")),
    hosts: loadHosts(path.resolve(expandHome(optional("HOSTS_FILE") ?? "hosts.json"))),
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
