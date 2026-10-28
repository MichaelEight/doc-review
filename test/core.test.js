import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMarkdown } from "../web/markdown.js";
import { makeAnchor, resolveAnchor, extractRefs } from "../web/anchor.js";
import { diffLines, acceptHunk, revertHunk } from "../web/diff.js";
import { offsetMapper, mapRange } from "../web/remap.js";
import { toggleWrap, command } from "../web/format.js";

// Every visible run must map 1:1 onto the source text.
function runs(node, out = []) {
  if (node.run != null) out.push(node);
  else for (const c of node.children || []) runs(c, out);
  return out;
}

test("markdown runs map exactly to source offsets", () => {
  const src = "# Title *x*\n\nSome **bold** and `code`, a [link](http://a.b) and $e=mc^2$.\n\n- item one\n- [x] done\n  - nested\n\n> quote **q**\n> more\n\n| a | b |\n|---|---|\n| 1 | **2** |\n\n```js\nlet a = 1;\n```\n\nEsc \\* star\n";
  const tree = parseMarkdown(src);
  const rs = runs(tree);
  assert.ok(rs.length > 10);
  for (const r of rs) assert.equal(src.slice(r.s, r.s + r.run.length), r.run, JSON.stringify(r));
  const tags = JSON.stringify(tree);
  for (const t of ['"h1"', '"strong"', '"code"', '"a"', '"math"', '"ul"', '"li"', '"blockquote"', '"table"', '"pre"']) assert.ok(tags.includes(t), t);
});

test("anchors survive edits around them and pick the right duplicate", () => {
  const text = "alpha beta gamma. alpha beta delta.";
  const a = makeAnchor(text, 18, 28); // second "alpha beta"
  assert.deepEqual(resolveAnchor(text, a), { start: 18, end: 28, exact: true });
  const edited = "NEW " + text;
  assert.equal(resolveAnchor(edited, a).start, 22);
  assert.equal(resolveAnchor("nothing here", a), null);
  const p = makeAnchor(text, 17, 17);
  assert.equal(resolveAnchor("XX" + text, p).start, 19);
});

test("refs are extracted from comment text", () => {
  assert.deepEqual(extractRefs("See @docs/a.md and #image-gs, mail a@b.c"), { files: ["docs/a.md"], tags: ["image-gs"] });
});

test("diff hunks accept and revert exactly", () => {
  const a = "one\ntwo\nthree\nfour\n";
  const b = "one\nTWO\nthree\nfour\nfive\n";
  const hs = diffLines(a, b);
  assert.equal(hs.length, 2);
  let base = a;
  for (const h of diffLines(base, b).reverse()) base = acceptHunk(base, h);
  assert.equal(base, b);
  let cur = b;
  for (const h of diffLines(a, cur).reverse()) cur = revertHunk(cur, h);
  assert.equal(cur, a);
});

test("ranges follow edits", () => {
  const a = "Intro line.\nThe quick brown fox.\nEnd.\n";
  const b = "Intro line.\nAdded.\nThe quick brown fox jumps.\nEnd.\n";
  const s = a.indexOf("quick");
  const m = mapRange(offsetMapper(a, b), s, s + 5);
  assert.equal(b.slice(m.start, m.end), "quick");
  const end = a.indexOf("End");
  assert.equal(b.slice(offsetMapper(a, b)(end), offsetMapper(a, b)(end) + 3), "End");
});

test("formatting toggles", () => {
  const t = "make this bold";
  const e = toggleWrap(t, 5, 9, ["**", "**"]);
  const t2 = t.slice(0, e.from) + e.insert + t.slice(e.to);
  assert.equal(t2, "make **this** bold");
  const u = toggleWrap(t2, e.selStart, e.selEnd, ["**", "**"]);
  assert.equal(t2.slice(0, u.from) + u.insert + t2.slice(u.to), t);
  const x = command("bold", "a word", 2, 6, "tex");
  assert.equal(x.insert, "\\textbf{word}");
});
