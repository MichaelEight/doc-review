import { test } from "node:test";
import assert from "node:assert/strict";
import { matchInSource, pointInSource } from "../web/pdfmatch.js";

const SRC = [
  "\\begin{proof}",
  "Suppose, for contradiction, that $\\sqrt{2} = \\frac{p}{q}$ for integers $p, q$",
  "and $\\gcd(p, q) = 1$. Squaring both sides gives",
  "So $p^2$ is even, and therefore $p$ is even. Write $p = 2k$. Then",
  "\\end{proof}",
].join("\n");
const slice = (m) => SRC.slice(m.start, m.end);

test("plain PDF text maps to the same words in the source", () => {
  const m = matchInSource(SRC, "Squaring both sides", 3, 3);
  assert.equal(slice(m), "Squaring both sides");
  assert.ok(m.exact);
});

test("rendered math maps across the LaTeX markup", () => {
  assert.equal(slice(matchInSource(SRC, "contradiction, that √2 = p q for integers p,", 2, 2)),
    "contradiction, that $\\sqrt{2} = \\frac{p}{q}$ for integers $p");
});

test("ligatures and line-end hyphens are undone", () => {
  const src = "We find the contradiction here.";
  const m = matchInSource(src, "We ﬁnd the contra- diction", 1, 1);
  assert.equal(src.slice(m.start, m.end), "We find the contradiction");
});

test("unmatched text falls back to the SyncTeX lines", () => {
  assert.equal(slice(matchInSource(SRC, "∎∎∎", 4, 4)), SRC.split("\n")[3]);
});

test("a click lands on the clicked word", () => {
  const pos = pointInSource(SRC, "Write", 4);
  assert.equal(SRC.slice(pos, pos + 5), "Write");
  assert.equal(SRC.slice(pointInSource(SRC, "zzz", 3)).slice(0, 3), "and");
});
