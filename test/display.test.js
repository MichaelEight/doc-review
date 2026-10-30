import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { globToRegExp, matchesScope, rulesFor, styleCss, ruleRanges, normalizeRule, okColor, parseStamp, formatDelta } from "../web/display.js";
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
  assert.throws(() => normalizeRule({ match: { literal: "a" }, style: {} }, "sty_1"), /needs a style/);
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
  const got = ruleRanges(text, rules).map((r) => [r.id, text.slice(r.start, r.end)]);
  assert.deepEqual(got, [["a", "nick"], ["b", "nick"], ["b", "nick"], ["a", "other"]]);
  // Overlapping rules both apply, so a segment can carry two declarations.
  assert.ok(got.filter(([, s]) => s === "nick").length === 3);
});

test("a zero-length regex match cannot spin forever", () => {
  const rules = [normalizeRule({ match: { regex: "x*" }, style: { bold: true } }, "a")];
  const got = ruleRanges("abcabc", rules);
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

test("a wait that times out hands the url back", async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, "a.md"), "hello\n");
  const ws = new Workspace(root);
  ws.uiUrl = "http://127.0.0.1:4848/?ws=abc&t=def";
  const out = await ws.waitForSubmit(20);
  assert.equal(out.status, "timeout");
  assert.equal(out.url, ws.uiUrl);
  assert.match(out.hint, /chat message/);
  ws.watcher?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("a gap is formatted the way the owner writes it", () => {
  assert.equal(formatDelta(16), "+0h 0m 16s");
  assert.equal(formatDelta(3661), "+1h 1m 1s");
  assert.equal(formatDelta(90061), "+1d 1h 1m 1s");
  assert.equal(formatDelta(-5), "-0h 0m 5s");
  assert.deepEqual(parseStamp("2013-11-15 16:02:59"), { t: Date.UTC(2013, 10, 15) / 1000 + 57779, dayless: false });
  assert.deepEqual(parseStamp("16:02:59"), { t: 57779, dayless: true });
  assert.equal(parseStamp("no time here"), null);
});

test("an annotation rule carries the gap since its previous match", () => {
  const text = ["2013-11-15 16:02:59  a", "2013-11-15 16:03:15  b", "2013-11-15 16:06:15  c", ""].join("\n");
  const rule = normalizeRule({
    label: "gap",
    match: { regex: String.raw`^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}`, flags: "m" },
    annotate: { text: "{delta}", show: "inline", delta: {} },
  }, "g");
  assert.equal(rule.annotate.show, "inline");
  const got = ruleRanges(text, [rule]);
  assert.equal(got.length, 3);
  assert.equal(got[0].note, null, "the first line has nothing to compare against");
  assert.equal(got[1].note, "+0h 0m 16s");
  assert.equal(got[2].note, "+0h 3m 0s");
  assert.equal(got[1].show, "inline");
});

test("a bare time wraps at midnight instead of going backwards", () => {
  const rule = normalizeRule({ match: { regex: String.raw`\d{2}:\d{2}:\d{2}` }, annotate: { text: "{delta}", delta: {} } }, "g");
  const got = ruleRanges(["23:59:50", "00:00:10", ""].join("\n"), [rule]);
  assert.equal(got[1].note, "+0h 0m 20s");
});

test("capture groups fill an annotation, and a rule may only annotate", () => {
  const rule = normalizeRule({ match: { regex: "<([^>]+)>" }, annotate: { text: "said by $1" } }, "g");
  assert.equal(styleCss(rule.style), "", "no styling at all is fine when there is a note");
  const got = ruleRanges("<CBremu> ok\n", [rule]);
  assert.equal(got[0].note, "said by CBremu");
  assert.equal(got[0].show, "hover", "hover is the default");
  assert.throws(() => normalizeRule({ match: { literal: "a" }, annotate: { text: "{delta}" } }, "g"), /set annotate.delta/);
  assert.throws(() => normalizeRule({ match: { literal: "a" }, annotate: { text: "  " } }, "g"), /annotate needs text/);
});
