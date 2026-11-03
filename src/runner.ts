/**
 * The runner: hosts agent sessions on this computer for a manglr gateway on
 * another one. The gateway starts it over SSH and talks to it on
 * stdin/stdout, one JSON message per line (see remote/protocol.ts), so
 * stdout carries protocol only: every log line goes to stderr.
 *
 *   node dist/runner.js        (normally started by the gateway, not by hand)
 */
import { createInterface } from "node:readline";

// Before anything can log: console.log would corrupt the protocol stream.
console.log = console.error;
console.info = console.error;
console.debug = console.error;

const { RunnerCore } = await import("./remote/runner-core.js");
const { log } = await import("./util/log.js");

process.stdout.on("error", () => process.exit(0)); // the gateway hung up mid-write

const core = new RunnerCore((msg) => void process.stdout.write(`${JSON.stringify(msg)}\n`));

let stopping = false;
const stop = async (why: string) => {
  if (stopping) return;
  stopping = true;
  log.info(`runner: ${why}, closing sessions`);
  await core.closeAll();
  process.exit(0);
};

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => void core.handle(line).catch((err) => log.error("runner: message failed", err)));
lines.on("close", () => void stop("gateway disconnected"));
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => void stop(signal));
process.on("uncaughtException", (err) => log.error("runner: uncaught", err));
process.on("unhandledRejection", (err) => log.error("runner: unhandled rejection", err));

core.hello();
