import { test } from "node:test";
import assert from "node:assert/strict";
import { Api } from "grammy";
import { PermissionBroker } from "../src/telegram/permissions.js";

/** An Api whose message edits hang (as when autoRetry waits out a 429) until released. */
function slowEdits() {
  const calls: string[] = [];
  let release!: () => void;
  const editsBlocked = new Promise<void>((r) => (release = r));
  const api = new Api("1:fake");
  api.config.use(async (_prev, method) => {
    calls.push(method);
    if (method === "editMessageText") await editsBlocked;
    return { ok: true, result: method === "sendMessage" ? { message_id: 50 } : true } as any;
  });
  return { api, calls, release };
}

const request = (signal = new AbortController().signal) => ({ tool: "Bash", summary: "git push", canAlwaysAllow: false, signal });

test("a permission tap settles at once, without waiting for the message edit", async () => {
  const { api, calls, release } = slowEdits();
  const broker = new PermissionBroker(api);
  const decision = broker.request(-1001, 7, request());
  await new Promise((r) => setImmediate(r)); // let the prompt be sent
  const id = (calls.includes("sendMessage") && [...(broker as any).pending.keys()][0]) as string;

  assert.equal(broker.answer(`perm:${id}:allow`), true); // synchronous: the tap can be answered now
  assert.equal(await decision, "allow");
  assert.equal(broker.answer(`perm:${id}:allow`), false); // already answered
  assert.equal(broker.answer("perm:nope:maybe"), false);
  release();
});

test("denyAll waits for the messages to show the denial", async () => {
  const { api, calls, release } = slowEdits();
  const broker = new PermissionBroker(api);
  const decision = broker.request(-1001, 7, request());
  await new Promise((r) => setImmediate(r));
  let done = false;
  const denying = broker.denyAll("gateway stopping").then(() => (done = true));
  assert.equal(await decision, "deny");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(done, false); // still editing
  release();
  await denying;
  assert.ok(calls.includes("editMessageText"));
});
