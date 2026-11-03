import type { PermissionMode, EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import type { ModelReasoningEffort, SandboxMode } from "@openai/codex-sdk";
import type { AgentKind, PermissionDecision } from "../agents/types.js";
import type { ModelChoice } from "../models.js";

/**
 * The hub ⇄ runner protocol: one JSON object per line over the runner's
 * stdin/stdout (in practice an SSH session). The runner hosts any number of
 * agent sessions, told apart by `sid`. Requests that need an answer carry a
 * `rid`, answered by a `result` with the same `rid`.
 */
export const PROTOCOL_VERSION = 1;

export interface SessionSpec {
  kind: AgentKind;
  /** Folder on the runner's host; a leading `~` is the runner user's home. */
  cwd: string;
  resume?: string;
  model?: string;
  effort?: string;
  claude: { permissionMode: PermissionMode; executable?: string };
  codex: { sandboxMode: SandboxMode; networkAccess: boolean; executable?: string };
}

export interface CatalogSpec {
  cwd: string;
  claude: { model?: string; effort?: EffortLevel; executable?: string };
  codex: { model?: string; reasoningEffort?: ModelReasoningEffort };
}

/** Hub → runner. */
export type HubMessage =
  | { t: "open"; rid: number; sid: string; spec: SessionSpec }
  | { t: "send"; sid: string; text: string }
  | { t: "setModel"; rid: number; sid: string; model?: string }
  | { t: "setEffort"; rid: number; sid: string; effort?: string }
  | { t: "interrupt"; rid: number; sid: string }
  | { t: "close"; rid: number; sid: string }
  | { t: "permission"; sid: string; pid: string; decision: PermissionDecision }
  | { t: "models"; rid: number; agent: AgentKind; spec: CatalogSpec };

/** What a session reports, mirroring AgentEvents (askPermission travels separately). */
export type SessionEvent =
  | { e: "sessionId"; id: string }
  | { e: "turnStarted" }
  | { e: "progress"; line: string }
  | { e: "reply"; text: string; final: boolean }
  | { e: "turnEnded"; error?: string; interrupted?: boolean; costUsd?: number };

/** Runner → hub. */
export type RunnerMessage =
  | { t: "ready"; protocol: number; hostname: string; home: string; node: string }
  | ({ t: "event"; sid: string } & SessionEvent)
  | { t: "askPermission"; sid: string; pid: string; tool: string; summary: string; reason?: string; canAlwaysAllow: boolean }
  /** The agent no longer waits for that permission (turn stopped). */
  | { t: "permissionCancelled"; sid: string; pid: string }
  | { t: "result"; rid: number; ok: true; value?: ModelChoice[] }
  | { t: "result"; rid: number; ok: false; error: string };
