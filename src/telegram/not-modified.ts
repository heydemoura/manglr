import type { Transformer } from "grammy";

/**
 * Editing a message to exactly what it already shows (a double-tapped menu
 * button, a card re-rendered with the same state) makes Telegram answer
 * "400: message is not modified". The message already looks right, so treat
 * it as success instead of failing the update.
 */
export const ignoreNotModified: Transformer = async (prev, method, payload, signal) => {
  const res = await prev(method, payload, signal);
  if (!res.ok && res.error_code === 400 && /message is not modified/i.test(res.description) && method.startsWith("editMessage")) {
    return { ok: true, result: true } as Awaited<ReturnType<typeof prev>>;
  }
  return res;
};
