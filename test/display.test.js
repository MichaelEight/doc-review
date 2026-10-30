import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { globToRegExp, matchesScope, rulesFor, styleCss, styleRanges, normalizeRule, okColor } from "../web/display.js";
import { Workspace } from "../src/workspace.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "docreview-style-"));

test("scope globs stay inside a path segment unless **", () => {
  assert.ok(globToRegExp("logs/*.txt").test("logs/a.txt"));
  assert.ok(!globToRegExp("logs/*.txt").test("logs/deep/a.txt"));
  assert.ok(globToRegExp("logs/**").test("logs/deep/a.txt"));
  assert.ok(globToRegExp("**").test("anything/at/all.md"));
  assert.ok(matchesScope(undefined, "x.md"), "no scope means every file");
  assert.ok(!matchesScope(["notes.md"], "other.md"));
});

test("only CSS colour syntax is accepted", () => {
  for (const ok of ["#fff", "#e0a800", "#11223344", "rgba(14,165,233,.18)", "hsl(200 50% 50%)", "rebeccapurple"]) {
    assert.ok(okColor(ok), ok);
  }
  for (const bad of ["red;background:url(x)", "expression(alert(1))", "url(http://a)", "}", "#ff"]) {
    assert.ok(!okColor(bad), bad);
  }
  assert.throws(() => normalizeRule({ match: { literal: "a" }, style: { color: "red;x:y" } }, "sty_1"), /CSS colour/);
});

test("a rule needs exactly one matcher and at least one style", () => {
  assert.throws(() => normalizeRule({ match: {}, style: { bold: true } }, "sty_1"), /exactly one/);
  assert.throws(() => normalizeRule({ match: { literal: "a", regex: "b" }, style: { bold: true } }, "sty_1"), /exactly one/);
  assert.throws(() => normalizeRule({ match: { literal: "a" }, style: {} }, "sty_1"), /at least one style/);
  assert.throws(() => normalizeRule({ match: { regex: "a(" }, style: { bold: true } }, "sty_1"), /bad regex/);
  const r = normalizeRule({ match: { literal: "Bob" }, style: { color: "#abc", bold: true } }, "sty_1");
  assert.equal(r.label, "Bob");
  assert.deepEqual(r.scope, ["**"]);
  assert.equal(styleCss(r.style), "color:#abc;font-weight:700");
});

test("literal and regex rules produce the ranges to paint", () => {
  const text = "<nick> hello nick\n<other> bye\n";
  const rules = [
    normalizeRule({ match: { regex: "<([^>]+)>", group: 1 }, style: { color: "#888" }, label: "inside <>" }, "a"),
    normalizeRule({ match: { literal: "nick", wholeWord: true }, style: { bold: true } }, "b"),
  ];
  const got = styleRanges(text, rules).map((r) => [r.id, text.slice(r.start, r.end)]);
  assert.deepEqual(got, [["a", "nick"], ["b", "nick"], ["b", "nick"], ["a", "other"]]);
  // Overlapping rules both apply, so a segment can carry two declarations.
  assert.ok(got.filter(([, s]) => s === "nick").length === 3);
});

test("a zero-length regex match cannot spin forever", () => {
  const rules = [normalizeRule({ match: { regex: "x*" }, style: { bold: true } }, "a")];
  const got = styleRanges("abcabc", rules);
  assert.deepEqual(got, []);
});

test("rules are stored per workspace, scoped, and switchable", () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, "logs"));
  fs.writeFileSync(path.join(root, "logs", "a.txt"), "<bob> hi\n");
  fs.writeFileSync(path.join(root, "notes.md"), "bob again\n");
  const ws = new Workspace(root);
  const [rule] = ws.setStyleRules([{ label: "bob", scope: ["logs/*.txt"], match: { literal: "bob" }, style: { color: "#e0a800" } }]);
  assert.match(rule.id, /^sty_/);
  assert.equal(ws.styleRules("logs/a.txt").length, 1);
  assert.equal(ws.styleRules("notes.md").length, 0, "out of scope");

  // The same id updates in place rather than piling up.
  ws.setStyleRules([{ id: rule.id, scope: ["**"], match: { literal: "bob" }, style: { color: "#111" } }]);
  assert.equal(ws.styleRules().length, 1);
  assert.equal(ws.styleRules("notes.md").length, 1);

  ws.enableStyleRule(rule.id, false);
  assert.equal(ws.styleRules("notes.md").length, 0, "disabled rules are not applied");
  assert.equal(ws.styleRules().length, 1, "but they are still there");

  // Survives a reload, because it lives in comments.json.
  ws.watcher?.close();
  const again = new Workspace(root);
  assert.equal(again.styleRules()[0].id, rule.id);
  assert.equal(again.styleRules()[0].enabled, false);

  assert.deepEqual(again.clearStyleRules([rule.id]), { removed: 1 });
  assert.equal(again.styleRules().length, 0);
  again.watcher?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("rulesFor skips disabled and out-of-scope rules", () => {
  const rules = [
    { id: "a", scope: ["**"], enabled: false, match: { literal: "x" }, style: { bold: true } },
    { id: "b", scope: ["logs/*.txt"], match: { literal: "x" }, style: { bold: true } },
  ];
  assert.deepEqual(rulesFor(rules, "logs/a.txt").map((r) => r.id), ["b"]);
  assert.deepEqual(rulesFor(rules, "notes.md").map((r) => r.id), []);
});
