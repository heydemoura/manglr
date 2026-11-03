import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkMarkdown, escapeHtml, markdownToHtml } from "../src/telegram/format.js";
import { oneLineCommand } from "../src/util/command.js";

test("escapes HTML outside and inside code", () => {
  assert.equal(escapeHtml("<a & b>"), "&lt;a &amp; b&gt;");
  assert.equal(markdownToHtml("x < y and `a<b>`"), "x &lt; y and <code>a&lt;b&gt;</code>");
});

test("converts fences with language", () => {
  const html = markdownToHtml("before\n```ts\nconst a = 1 < 2;\n```\nafter");
  assert.equal(html, 'before\n<pre><code class="language-ts">const a = 1 &lt; 2;</code></pre>\nafter');
});

test("converts headings, bullets, bold, italic, links", () => {
  assert.equal(markdownToHtml("## Title"), "<b>Title</b>");
  assert.equal(markdownToHtml("- item **bold**"), "• item <b>bold</b>");
  assert.equal(markdownToHtml("an *italic* word"), "an <i>italic</i> word");
  assert.equal(markdownToHtml("[docs](https://x.dev/a?b=1&c=2)"), '<a href="https://x.dev/a?b=1&amp;c=2">docs</a>');
});

test("does not format inside inline code", () => {
  assert.equal(markdownToHtml("`**not bold**`"), "<code>**not bold**</code>");
});

test("leaves multiplication-like asterisks alone", () => {
  assert.equal(markdownToHtml("2*3*4"), "2*3*4");
});

test("short text is one chunk", () => {
  assert.deepEqual(chunkMarkdown("hello\nworld", 100), ["hello\nworld"]);
});

test("chunks stay under the limit and reopen code fences", () => {
  const code = Array.from({ length: 60 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
  const md = `intro\n\`\`\`py\n${code}\n\`\`\`\noutro`;
  const chunks = chunkMarkdown(md, 400);
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.ok(c.length <= 400, `chunk too long: ${c.length}`);
    const fences = c.split("\n").filter((l) => l.startsWith("```")).length;
    assert.equal(fences % 2, 0, `unbalanced fences in chunk:\n${c}`);
  }
  assert.ok(chunks[1]!.startsWith("```py"));
  assert.ok(chunks.at(-1)!.endsWith("outro"));
});

test("hard-splits a single giant line", () => {
  const chunks = chunkMarkdown("y".repeat(1000), 300);
  assert.ok(chunks.length >= 4);
  assert.equal(chunks.join(""), "y".repeat(1000));
  for (const c of chunks) assert.ok(c.length <= 300);
});

test("unwraps shell wrappers and joins lines", () => {
  assert.equal(oneLineCommand(`/bin/zsh -lc "printf 'hi' > hello.txt\nls"`), "printf 'hi' > hello.txt ⏎ ls");
  assert.equal(oneLineCommand("bash -c 'echo a'"), "echo a");
  assert.equal(oneLineCommand("git status"), "git status");
});
