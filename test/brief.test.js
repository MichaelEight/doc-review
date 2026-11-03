import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspace } from "../src/workspace.js";
import { normalizeBrief, briefLabel, BRIEF_PRESETS } from "../web/briefs.js";

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dr-brief-"));
  fs.writeFileSync(path.join(dir, "a.md"), "An important name here.\n");
  return new Workspace(dir);
}
const comment = (ws, text) => ws.addThread({ file: "a.md", anchor: { quote: "important name", prefix: "An ", suffix: " here" }, text });

test("normalizeBrief trims and drops empties", () => {
  assert.equal(normalizeBrief({ text: "  ", target: "" }), null);
  assert.deepEqual(normalizeBrief({ text: " keep ", target: "./notes.md " }), { text: "keep", target: "notes.md" });
  assert.equal(briefLabel({ text: BRIEF_PRESETS[0].text }), BRIEF_PRESETS[0].name);
  assert.equal(briefLabel({ text: "one two three four five six" }), "one two three four five…");
});

test("the standing instruction reaches the agent with its target file", () => {
  const ws = workspace();
  try {
    ws.setBrief({ text: "Don't edit, collect.", target: "notes/collected.md" });
    comment(ws, "important name");
    ws.submit();
    const got = ws.deliver();
    assert.equal(got.instruction.text, "Don't edit, collect.");
    assert.equal(got.instruction.target_file, "notes/collected.md");
    assert.equal(got.instruction.target_abs_path, path.join(ws.root, "notes/collected.md"));
    assert.equal(got.instruction.target_exists, false);
    assert.match(got.next, /standing instruction/);
    assert.deepEqual(ws.state.rounds.at(-1).brief, { text: "Don't edit, collect.", target: "notes/collected.md" });
    // It stays set for the next round...
    ws.endRound("done");
    comment(ws, "todo");
    ws.submit();
    assert.ok(ws.deliver().instruction);
    // ...unless the user sends without it.
    ws.endRound("done");
    comment(ws, "plain");
    ws.submit({ withBrief: false });
    const plain = ws.deliver();
    assert.equal(plain.instruction, undefined);
    assert.doesNotMatch(plain.next, /standing instruction/);
  } finally {
    ws.close();
  }
});

test("instruction targets stay inside the workspace, presets need a name", () => {
  const ws = workspace();
  try {
    assert.throws(() => ws.setBrief({ text: "x", target: "../outside.md" }), /outside/);
    assert.throws(() => ws.saveBriefPreset({ name: "", text: "x" }), /name/);
    const p = ws.saveBriefPreset({ name: "Mine", text: "Collect", target: "n.md" });
    ws.saveBriefPreset({ name: "Mine", text: "Collect v2" });
    assert.equal(ws.state.briefPresets.length, 1);
    assert.equal(ws.state.briefPresets[0].text, "Collect v2");
    ws.deleteBriefPreset(ws.state.briefPresets[0].id);
    assert.equal(ws.state.briefPresets.length, 0);
    assert.ok(p.id);
    ws.setBrief({ text: "", target: "" });
    assert.equal(ws.state.brief, null);
  } finally {
    ws.close();
  }
});
