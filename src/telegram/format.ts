/**
 * Agent replies are Markdown; Telegram's HTML parse mode is the predictable
 * one (MarkdownV2 needs escaping everywhere). These helpers convert the common
 * subset and split long text into messages under Telegram's 4096-char cap.
 */

export const TELEGRAM_LIMIT = 4096;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const escapeAttr = (s: string) => escapeHtml(s).replace(/"/g, "&quot;");

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;

/** Convert the Markdown subset agents use to Telegram HTML. */
export function markdownToHtml(md: string): string {
  const out: string[] = [];
  const lines = md.split("\n");
  let i = 0;
  while (i < lines.length) {
    const fence = FENCE.exec(lines[i]!);
    if (fence) {
      const [, , marker, lang] = fence;
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(marker!)) body.push(lines[i++]!);
      i++; // closing fence (or end of text)
      const cls = lang ? ` class="language-${escapeAttr(lang)}"` : "";
      out.push(`<pre><code${cls}>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }
    out.push(inlineLine(lines[i]!));
    i++;
  }
  return out.join("\n");
}

function inlineLine(line: string): string {
  const heading = /^#{1,6}\s+(.*)$/.exec(line);
  if (heading) return `<b>${inline(heading[1]!)}</b>`;
  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
  if (bullet) return `${bullet[1]}• ${inline(bullet[2]!)}`;
  const quote = /^>\s?(.*)$/.exec(line);
  if (quote) return `<blockquote>${inline(quote[1]!)}</blockquote>`;
  return inline(line);
}

/** Inline code first (its content is literal), then links, bold, italics, strike. */
function inline(text: string): string {
  return text
    .split(/(`[^`\n]+`)/)
    .map((part, idx) => {
      if (idx % 2 === 1) return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      let s = escapeHtml(part);
      s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, t: string, url: string) => `<a href="${url.replace(/"/g, "&quot;")}">${t}</a>`);
      s = s.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
      s = s.replace(/__([^_\n]+)__/g, "<b>$1</b>");
      s = s.replace(/(^|[\s(])\*([^*\s][^*\n]*?)\*(?=[\s).,!?:;]|$)/g, "$1<i>$2</i>");
      s = s.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");
      return s;
    })
    .join("");
}

/**
 * Split Markdown into chunks of at most `limit` characters, preferring line
 * boundaries, and closing/reopening code fences across a split so every chunk
 * renders on its own.
 */
export function chunkMarkdown(md: string, limit = 3500): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let size = 0;
  let openFence: { marker: string; lang: string } | null = null;

  const flush = () => {
    if (current.length === 0) return;
    if (openFence) current.push(openFence.marker);
    chunks.push(current.join("\n"));
    current = openFence ? [`${openFence.marker}${openFence.lang}`] : [];
    size = current.length ? current[0]!.length + 1 : 0;
  };

  const reserve = () => (openFence ? openFence.marker.length + 1 : 0);

  for (const rawLine of md.split("\n")) {
    // Hard-split lines that can never fit.
    const pieces: string[] = [];
    const room = Math.max(200, limit - 2 * 12);
    for (let s = rawLine; ; s = s.slice(room)) {
      pieces.push(s.slice(0, room));
      if (s.length <= room) break;
    }
    for (const line of pieces) {
      if (size + line.length + 1 + reserve() > limit && current.length > 0) flush();
      current.push(line);
      size += line.length + 1;
      const fence = FENCE.exec(line);
      if (fence) openFence = openFence ? null : { marker: fence[2]!, lang: fence[3] ?? "" };
    }
  }
  if (openFence) openFence = null; // unterminated fence: leave as written
  if (current.length) chunks.push(current.join("\n"));
  return chunks.filter((c) => c.trim().length > 0);
}

/** A quoted, clipped excerpt for status/permission messages (already HTML-escaped). */
export function codeBlock(text: string, max = 900): string {
  const clipped = text.length > max ? `${text.slice(0, max - 1)}…` : text;
  return `<pre>${escapeHtml(clipped)}</pre>`;
}
