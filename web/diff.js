// Line diff (LCS on the region between common prefix/suffix) grouped into hunks, plus word diff
// for highlighting inside changed lines. Shared by server tests and the browser.

function lcsOps(a, b) {
  // Returns ops: ["=", ai, bi] | ["-", ai] | ["+", bi]
  const n = a.length;
  const m = b.length;
  if (n * m > 16_000_000) {
    return [...a.map((_, i) => ["-", i]), ...b.map((_, j) => ["+", j])];
  }
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) ops.push(["=", i++, j++]);
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) ops.push(["-", i++]);
    else ops.push(["+", j++]);
  }
  while (i < n) ops.push(["-", i++]);
  while (j < m) ops.push(["+", j++]);
  return ops;
}

export function splitLines(text) {
  // Keep line terminators so hunks re-join to the exact text.
  return text.match(/[^\n]*\n|[^\n]+$/g) || [];
}

// Hunk: { aStart, aEnd, bStart, bEnd, removed: string[], added: string[] } in line indexes.
export function diffLines(oldText, newText) {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  const ops = lcsOps(am, bm);
  const hunks = [];
  let cur = null;
  let ai = pre;
  let bi = pre;
  for (const op of ops) {
    if (op[0] === "=") {
      if (cur) hunks.push(cur), (cur = null);
      ai++, bi++;
      continue;
    }
    if (!cur) cur = { aStart: ai, aEnd: ai, bStart: bi, bEnd: bi, removed: [], added: [] };
    if (op[0] === "-") cur.removed.push(a[ai++]), (cur.aEnd = ai);
    else cur.added.push(b[bi++]), (cur.bEnd = bi);
  }
  if (cur) hunks.push(cur);
  return hunks;
}

// Apply a hunk to the old text (accept) or undo it in the new text (revert).
export function acceptHunk(oldText, hunk) {
  const a = splitLines(oldText);
  a.splice(hunk.aStart, hunk.aEnd - hunk.aStart, ...hunk.added);
  return a.join("");
}

export function revertHunk(newText, hunk) {
  const b = splitLines(newText);
  b.splice(hunk.bStart, hunk.bEnd - hunk.bStart, ...hunk.removed);
  return b.join("");
}

// Word-level diff between two strings: [{ t: "=" | "-" | "+", s: string }].
export function diffWords(x, y) {
  const a = x.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) || [];
  const b = y.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) || [];
  const out = [];
  const push = (t, s) => {
    const last = out[out.length - 1];
    if (last && last.t === t) last.s += s;
    else out.push({ t, s });
  };
  for (const op of lcsOps(a, b)) {
    if (op[0] === "=") push("=", a[op[1]]);
    else if (op[0] === "-") push("-", a[op[1]]);
    else push("+", b[op[1]]);
  }
  return out;
}
