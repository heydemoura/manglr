const debugEnabled = process.env.DEBUG === "1" || process.env.DEBUG === "true";

const stamp = () => new Date().toISOString();

export const log = {
  info: (...args: unknown[]) => console.log(stamp(), "INFO", ...args),
  warn: (...args: unknown[]) => console.warn(stamp(), "WARN", ...args),
  error: (...args: unknown[]) => console.error(stamp(), "ERROR", ...args),
  debug: (...args: unknown[]) => {
    if (debugEnabled) console.log(stamp(), "DEBUG", ...args);
  },
};
