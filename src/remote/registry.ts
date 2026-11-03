import type { AgentEvents, AgentKind, AgentSession } from "../agents/types.js";
import type { Config } from "../config.js";
import type { HostConfig } from "../hosts.js";
import { ModelCatalog } from "../models.js";
import { RemoteHost, sshSpawner, type Spawner } from "./host.js";

/** What the Telegram side needs to know about remote hosts. */
export interface HostDirectory {
  /** Remote host names, in hosts-file order. */
  names(): string[];
  config(name: string): HostConfig;
  catalog(name: string): ModelCatalog;
}

/** The configured remote hosts, their connections and model menus. */
export class HostRegistry implements HostDirectory {
  private readonly hosts = new Map<string, RemoteHost>();
  private readonly catalogs = new Map<string, ModelCatalog>();

  constructor(
    private readonly cfg: Config,
    spawner: Spawner = sshSpawner,
  ) {
    for (const h of cfg.hosts) {
      const host = new RemoteHost(h, spawner);
      this.hosts.set(h.name, host);
      // Menus come from the host's own agents; the env defaults still apply.
      this.catalogs.set(
        h.name,
        new ModelCatalog(cfg, (agent) =>
          host.listModels(agent, {
            cwd: h.cwd,
            claude: { model: cfg.claude.model, effort: cfg.claude.effort, executable: h.claudePath },
            codex: { model: cfg.codex.model, reasoningEffort: cfg.codex.reasoningEffort },
          }),
        ),
      );
    }
  }

  names(): string[] {
    return [...this.hosts.keys()];
  }

  config(name: string): HostConfig {
    return this.host(name).cfg;
  }

  catalog(name: string): ModelCatalog {
    const catalog = this.catalogs.get(name);
    if (!catalog) throw unknownHost(name);
    return catalog;
  }

  session(
    name: string,
    kind: AgentKind,
    init: { cwd: string; resume?: string; model?: string; effort?: string },
    events: AgentEvents,
  ): AgentSession {
    const host = this.host(name);
    const { claude, codex } = this.cfg;
    return host.session(
      {
        kind,
        cwd: init.cwd,
        claude: { permissionMode: claude.permissionMode, executable: host.cfg.claudePath },
        codex: { sandboxMode: codex.sandboxMode, networkAccess: codex.networkAccess, executable: host.cfg.codexPath },
      },
      init,
      events,
    );
  }

  shutdown(): void {
    for (const host of this.hosts.values()) host.shutdown();
  }

  private host(name: string): RemoteHost {
    const host = this.hosts.get(name);
    if (!host) throw unknownHost(name);
    return host;
  }
}

const unknownHost = (name: string) => new Error(`host "${name}" is not in the hosts file anymore`);
