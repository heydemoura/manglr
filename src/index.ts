import { autoRetry } from "@grammyjs/auto-retry";
import { Bot, GrammyError } from "grammy";
import { loadConfig, type Config } from "./config.js";
import { ModelCatalog } from "./models.js";
import { SessionManager } from "./sessions.js";
import { SessionStore } from "./store.js";
import { COMMANDS, registerHandlers } from "./telegram/bot.js";
import { PermissionBroker } from "./telegram/permissions.js";
import { log } from "./util/log.js";

let cfg: Config;
try {
  cfg = loadConfig();
} catch (err) {
  console.error(`Config error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
const bot = new Bot(cfg.telegram.token);
bot.api.config.use(autoRetry({ maxRetryAttempts: 5, maxDelaySeconds: 60 }));

const store = new SessionStore(cfg.dataDir);
const permissions = new PermissionBroker(bot.api);
const manager = new SessionManager(cfg, bot.api, store, permissions);
const models = new ModelCatalog(cfg);
registerHandlers(bot, cfg, store, manager, permissions, models);

if (cfg.setupMode) {
  log.warn(
    "Setup mode: TELEGRAM_CHAT_ID or TELEGRAM_ALLOWED_USER_IDS is not set. " +
      "Send /whoami to the bot (in your group and in a private chat) to get the ids, put them in .env, and restart.",
  );
} else {
  const chat = await bot.api.getChat(cfg.telegram.chatId!);
  if (!("is_forum" in chat) || !chat.is_forum) {
    throw new Error(`Chat ${cfg.telegram.chatId} is not a supergroup with Topics enabled`);
  }
  const me = await bot.api.getChatMember(cfg.telegram.chatId!, (await bot.api.getMe()).id);
  if (me.status !== "creator" && !(me.status === "administrator" && me.can_manage_topics)) {
    log.warn(
      `The bot is ${me.status} in "${chat.title}" without the Manage Topics right: /new will fail. ` +
        "Make it an admin with Manage Topics (group settings → Administrators).",
    );
  }
  await bot.api.setMyCommands(COMMANDS, { scope: { type: "chat", chat_id: cfg.telegram.chatId! } });
  void models.list("claude"); // warm the model menu (starts Claude Code once, no prompt)
  void models.list("codex");
  log.info(`Serving "${chat.title}" for ${cfg.telegram.allowedUserIds.size} user(s); sessions start in ${cfg.workdir.path}`);
}

let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  log.info(`${signal}: shutting down`);
  await bot.stop();
  await manager.shutdown();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await bot.start({
    allowed_updates: ["message", "callback_query"],
    onStart: (me) => log.info(`Bot @${me.username} is polling`),
  });
} catch (err) {
  // bot.stop() during a retry backoff rejects start() with "Aborted delay".
  // That's our own shutdown, which finishes and exits on its own.
  if (!stopping) {
    if (err instanceof GrammyError && err.error_code === 409) {
      log.error("Another process is polling with this bot token (Telegram allows one). Stop it, then restart the gateway.");
    } else {
      log.error("polling stopped", err);
    }
    await manager.shutdown().catch(() => undefined);
    process.exit(1);
  }
}
