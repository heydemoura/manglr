import { test } from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import type { query } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../src/config.js";
import { cleanTitle, createTitleSummarizer } from "../src/topic-titles.js";

test("title normalization removes wrapping and line breaks and bounds title length", () => {
  assert.equal(cleanTitle('  "Fix login\nand regression coverage"  '), "Fix login and regression coverage");
  assert.equal(cleanTitle("**Upload timeout**"), "Upload timeout");
  assert.equal(cleanTitle("x".repeat(200)).length, 110);
});

test("title requests use isolated tool-free sessions and remove their temporary folder", async () => {
  let request: Parameters<typeof query>[0] | undefined;
  let closed = false;
  const run = ((input) => {
    request = input;
    return {
      async *[Symbol.asyncIterator]() { yield { type: "result", subtype: "success", is_error: false, result: "Login redirect and regression coverage" }; },
      close() { closed = true; },
    };
  }) as typeof query;
  const summarize = createTitleSummarizer({ topicTitleModel: "haiku", claude: {} } as Config, run);
  const title = await summarize("Original goal", [{ role: "user", text: "Fix the login redirect" }, { role: "assistant", text: "Added regression tests." }], new AbortController().signal);
  assert.equal(title, "Login redirect and regression coverage");
  const opts = request!.options!;
  assert.deepEqual(opts.tools, []);
  assert.deepEqual(opts.settingSources, []);
  assert.deepEqual(opts.mcpServers, {});
  assert.equal(opts.strictMcpConfig, true);
  assert.equal(opts.permissionMode, "dontAsk");
  assert.equal(opts.persistSession, false);
  assert.equal(opts.maxTurns, 1);
  assert.equal(opts.model, "haiku");
  assert.match(String(request!.prompt), /regression tests/);
  assert.equal(closed, true);
  await assert.rejects(access(opts.cwd!), { code: "ENOENT" });
});
