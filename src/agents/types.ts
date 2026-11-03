export type AgentKind = "claude" | "codex";

export const AGENTS: Record<AgentKind, { label: string; emoji: string }> = {
  claude: { label: "Claude", emoji: "🟠" },
  codex: { label: "Codex", emoji: "🟢" },
};

export interface PermissionRequest {
  tool: string;
  /** Human-readable one-liner of what the tool wants to do. */
  summary: string;
  /** Why the agent is asking (e.g. a path outside the allowed folders). */
  reason?: string;
  /** "Always allow" is only offered when the agent supplied a rule for it. */
  canAlwaysAllow: boolean;
  signal: AbortSignal;
}

export type PermissionDecision = "allow" | "always" | "deny";

/** What an agent session reports back; implemented by the Telegram topic UI. */
export interface AgentEvents {
  /** The agent's own session/thread id, once known: persist it to resume later. */
  sessionId(id: string): void;
  /** A turn started working. */
  turnStarted(): void;
  /** A short line about what the agent is doing ("✏️ Edit src/x.ts"). */
  progress(line: string): void;
  /** Text the agent wrote for the person. `final` is the turn's last answer. */
  reply(text: string, final: boolean): void;
  /** The turn ended. `error` is set when it failed or was interrupted. */
  turnEnded(info: { error?: string; interrupted?: boolean; costUsd?: number }): void;
  /** The agent needs a decision before running a tool. */
  askPermission(req: PermissionRequest): Promise<PermissionDecision>;
}

export interface AgentSession {
  readonly kind: AgentKind;
  /** A turn is running. */
  readonly busy: boolean;
  /** Send the person's message. While busy it is queued for the agent. */
  send(text: string): void;
  /**
   * Switch the model for what comes next (undefined: the agent's default).
   * Claude switches from its next response, even mid-turn; Codex from its next turn.
   */
  setModel(model: string | undefined): Promise<void>;
  /** Stop the running turn; the session stays usable. */
  interrupt(): Promise<void>;
  /** End the session for good (the transcript stays on disk). */
  close(): Promise<void>;
}
