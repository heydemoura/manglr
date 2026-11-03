import { existsSync, readFileSync } from "node:fs";

/** Another computer whose agents the gateway drives, through a runner started over SSH. */
export interface HostConfig {
  /** Shown in Telegram and kept with each session; letters, digits, `.`, `_`, `-`. */
  name: string;
  /** SSH destination (`user@host` or a `~/.ssh/config` alias). Default: `name`. */
  ssh: string;
  /** Folder sessions start in on that host. `~` is the remote user's home. */
  cwd: string;
  /** Remote shell command that starts the runner, speaking the protocol on stdin/stdout. */
  command: string;
  /** Claude Code / Codex binaries on that host; unset: the SDKs find their own. */
  claudePath?: string;
  codexPath?: string;
}

export const DEFAULT_RUNNER_COMMAND = "cd ~/manglr && exec node dist/runner.js";

const NAME = /^[A-Za-z0-9._-]{1,24}$/;

/**
 * Read the hosts file: a JSON array of `{ "name": "bazzite", "ssh": "bazzite@192.168.0.146" }`
 * objects (see hosts.example.json). No file: no remote hosts, everything runs on this one.
 */
export function loadHosts(file: string): HostConfig[] {
  if (!existsSync(file)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(raw)) throw new Error(`${file} must be a JSON array of hosts`);
  const seen = new Set<string>();
  return raw.map((entry, i) => {
    const h = (entry ?? {}) as Record<string, unknown>;
    const str = (key: string): string | undefined => {
      const v = h[key];
      if (v === undefined) return undefined;
      if (typeof v !== "string" || !v.trim()) throw new Error(`${file}: host #${i + 1} has a bad "${key}"`);
      return v.trim();
    };
    const name = str("name");
    if (!name || !NAME.test(name)) {
      throw new Error(`${file}: host #${i + 1} needs a "name" of up to 24 letters, digits, ".", "_" or "-"`);
    }
    if (name === "local") throw new Error(`${file}: "local" is reserved for this host`);
    if (seen.has(name)) throw new Error(`${file}: host "${name}" is listed twice`);
    seen.add(name);
    return {
      name,
      ssh: str("ssh") ?? name,
      cwd: str("cwd") ?? "~",
      command: str("command") ?? DEFAULT_RUNNER_COMMAND,
      claudePath: str("claudePath"),
      codexPath: str("codexPath"),
    };
  });
}
