import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const server = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "server.js");

test("full round: open, comment via HTTP, wait receives it, AI resolves", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dr-"));
  fs.writeFileSync(path.join(dir, "a.md"), "# Hello\n\nThis sentance has a typo.\n");
  const proc = spawn(process.execPath, [server], { env: { ...process.env, DOC_REVIEW_PORT: "48700" } });
  const replies = new Map();
  let buf = "";
  proc.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (m.id != null) replies.set(m.id, m);
    }
  });
  const call = async (id, name, args) => {
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
    for (let k = 0; k < 100 && !replies.has(id); k++) await new Promise((r) => setTimeout(r, 30));
    const r = replies.get(id);
    return r.result.isError ? Promise.reject(new Error(r.result.content[0].text)) : JSON.parse(r.result.content[0].text);
  };
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18" } }) + "\n");
  try {
    const open = await call(1, "review_open", { path: dir, open_browser: false });
    // The agent has to be told to put the url in the chat: review_wait blocks for minutes after it.
    assert.match(open.next, /chat message FIRST/);
    const u = new URL(open.url);
    const ws = u.searchParams.get("ws");
    const t = u.searchParams.get("t");
    const http = (m, p, body) => fetch(`${u.origin}${p}${p.includes("?") ? "&" : "?"}ws=${ws}`, { method: m, headers: { "x-token": t, "content-type": "application/json" }, body: body && JSON.stringify(body) }).then((r) => r.json());
    const bad = await fetch(`${u.origin}/api/state?ws=${ws}`).then((r) => r.status);
    assert.equal(bad, 403);
    const text = fs.readFileSync(path.join(dir, "a.md"), "utf8");
    const s = text.indexOf("sentance");
    await http("POST", "/api/threads", { file: "a.md", anchor: { quote: "sentance", prefix: text.slice(s - 10, s), suffix: text.slice(s + 8, s + 20) }, text: "typo, see @a.md #spelling" });
    // review_wait blocks; submit while it waits.
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "review_wait", arguments: { timeout_seconds: 10 } } }) + "\n");
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(replies.has(2), false);
    const sub = await http("POST", "/api/submit");
    assert.equal(sub.agentWaiting, true);
    for (let k = 0; k < 100 && !replies.has(2); k++) await new Promise((r) => setTimeout(r, 30));
    const got = JSON.parse(replies.get(2).result.content[0].text);
    assert.equal(got.status, "submitted");
    assert.equal(got.comments[0].quote, "sentance");
    assert.equal(got.comments[0].line, 3);
    assert.ok(got.referenced_files["@a.md"]);
    assert.ok(got.tags["#spelling"]);
    // While the AI works the UI cannot write.
    const locked = await fetch(`${u.origin}/api/file?ws=${ws}`, { method: "PUT", headers: { "x-token": t }, body: JSON.stringify({ path: "a.md", text: "x" }) }).then((r) => r.status);
    assert.equal(locked, 423);
    fs.writeFileSync(path.join(dir, "a.md"), text.replace("sentance", "sentence"));
    await new Promise((r) => setTimeout(r, 300));
    await call(3, "review_resolve", { comment_id: got.comments[0].id, note: "Corrected" });
    const fin = await call(4, "review_finish", { summary: "Fixed typo" });
    assert.deepEqual(fin.changed_files, ["a.md"]);
    const st = await http("GET", "/api/state");
    assert.equal(st.threads[0].status, "resolved");
    assert.equal(st.threads[0].anchor.quote, "sentence");
    assert.equal(st.threads[0].messages.at(-1).text, "Corrected");
  } finally {
    proc.kill();
  }
});
