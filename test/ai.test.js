import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DOC_REVIEW_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dr-cfg-"));
process.env.DOC_REVIEW_TOKEN_FILE = path.join(process.env.DOC_REVIEW_CONFIG_DIR, "token");
process.env.DOC_REVIEW_PORT = "48750";
const { createServer } = await import("../src/server.js");

import { makeAnchor } from "../web/anchor.js";

// A fake OpenAI-compatible service. Each script entry is a function of the requests seen so far.
function fakeLLM(script) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      const body = JSON.parse(b);
      seen.push({ auth: req.headers.authorization, body });
      const step = (script.shift() ?? (() => ({ content: "done" })))(seen);
      const message = { role: "assistant", content: step.content ?? null };
      if (step.calls) message.tool_calls = step.calls.map(([name, args], i) => ({ id: `c${seen.length}_${i}`, type: "function", function: { name, arguments: JSON.stringify(args) } }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message }], usage: { total_tokens: 100 } }));
    });
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, seen, url: `http://127.0.0.1:${srv.address().port}/v1` })));
}

const commentId = (seen) => JSON.parse(seen[0].body.messages[1].content.split("\n").slice(1).join("\n")).comments[0].id;
const until = async (fn) => {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error("timed out");
};

test("standalone: the built-in AI edits the file, resolves the comment, and the key stays private", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dr-"));
  const body = "# Hello\n\nThis sentance has a typo.\n";
  fs.writeFileSync(path.join(dir, "a.md"), body);
  const llm = await fakeLLM([
    () => ({ calls: [["replace_in_file", { path: "a.md", old_text: "sentance", new_text: "sentence" }]] }),
    (seen) => ({ calls: [["review_resolve", { comment_id: commentId(seen), note: "Corrected" }]] }),
    () => ({ calls: [["review_finish", { summary: "Fixed typo" }]] }),
  ]);
  const server = createServer({ standalone: true });
  try {
    await server.http.listen();
    const ws = server.openFolder(dir);
    server.ai.set({ preset: "custom", baseUrl: llm.url, model: "m", apiKey: "sk-secret" });
    assert.ok(!JSON.stringify(server.ai.publicSettings()).includes("sk-secret"));
    // POSIX permission bits mean nothing on Windows; the file lives in the user profile there.
    if (process.platform !== "win32") assert.equal(fs.statSync(path.join(process.env.DOC_REVIEW_CONFIG_DIR, "ai.json")).mode & 0o077, 0);

    const u = new URL(server.http.url(ws));
    const call = (m, p, b) => fetch(`${u.origin}${p}?ws=${ws.id}&t=${u.searchParams.get("t")}`, { method: m, headers: { "content-type": "application/json" }, body: b && JSON.stringify(b) }).then((r) => r.json());
    const at = body.indexOf("sentance");
    await call("POST", "/api/threads", { file: "a.md", anchor: makeAnchor(body, at, at + 8), text: "typo" });
    await until(() => ws.waiters.length === 1); // built-in AI is listening
    const sent = await call("POST", "/api/submit", {});
    assert.equal(sent.agentWaiting, true);
    await until(() => ws.lastSummary?.text.startsWith("Fixed typo"));

    assert.equal(fs.readFileSync(path.join(dir, "a.md"), "utf8"), "# Hello\n\nThis sentence has a typo.\n");
    assert.equal(ws.state.threads[0].status, "resolved");
    assert.equal(llm.seen[0].auth, "Bearer sk-secret");
    assert.equal((await call("GET", "/api/ai")).hasKey, true);
  } finally {
    server.close();
    llm.srv.close();
  }
});

test("standalone: replace_in_file refuses ambiguous or missing text", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dr-"));
  fs.writeFileSync(path.join(dir, "a.md"), "x x\n");
  const server = createServer({ standalone: true });
  try {
    const ws = server.openFolder(dir);
    await assert.rejects(server.ai.runTool(ws, "replace_in_file", { path: "a.md", old_text: "x", new_text: "y" }), /2 times/);
    await assert.rejects(server.ai.runTool(ws, "replace_in_file", { path: "a.md", old_text: "zzz", new_text: "y" }), /not found/);
    await assert.rejects(server.ai.runTool(ws, "read_file", { path: "../../etc/passwd" }), /outside workspace/);
  } finally {
    server.close();
  }
});
