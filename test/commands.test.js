import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { COMMANDS, parseCommand } from "../web/commands.js";
import { makeAnchor } from "../web/anchor.js";
import { Workspace } from "../src/workspace.js";

test("slash commands parse only at the start of a message", () => {
  assert.deepEqual(
    (({ name, args }) => ({ name, args }))(parseCommand("/shorten 50%")),
    { name: "shorten", args: "50%" });
  assert.equal(parseCommand("/Fix").name, "fix");
  assert.equal(parseCommand("/translate Polish\nkeep names").note, "keep names");
  assert.equal(parseCommand("/nope x"), null);
  assert.equal(parseCommand("please /fix"), null);
  for (const c of COMMANDS) {
    assert.ok(["edit", "reply", "confirm"].includes(c.action), c.name);
    assert.ok(c.summary && c.instructions && c.examples.length, c.name);
  }
});

test("a delivered comment carries its command and instructions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dr-cmd-"));
  const text = "One two three four five six.\n";
  fs.writeFileSync(path.join(dir, "a.md"), text);
  const ws = new Workspace(dir);
  try {
    ws.addThread({ file: "a.md", anchor: makeAnchor(text, 0, 13), text: "/shorten one word" });
    ws.addThread({ file: "a.md", anchor: makeAnchor(text, 14, 18), text: "plain comment" });
    ws.submit();
    const out = ws.deliver();
    const [cmd, plain] = out.comments;
    assert.equal(cmd.command.name, "shorten");
    assert.equal(cmd.command.args, "one word");
    assert.equal(cmd.command.action, "edit");
    assert.match(cmd.command.instructions, /Shorten/);
    assert.equal(plain.command, undefined);
  } finally {
    ws.close?.();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
