// Text anchors that survive edits: a comment remembers the quoted text plus a little context on
// each side (W3C TextQuoteSelector style), not a character offset. Shared by server and browser.

export const CONTEXT = 32;

export function makeAnchor(text, start, end) {
  return {
    quote: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - CONTEXT), start),
    suffix: text.slice(end, end + CONTEXT),
    hint: start,
  };
}

function commonSuffix(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

function commonPrefix(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

function occurrences(text, needle, limit = 500) {
  const out = [];
  if (!needle) return out;
  let i = text.indexOf(needle);
  while (i >= 0 && out.length < limit) {
    out.push(i);
    i = text.indexOf(needle, i + 1);
  }
  return out;
}

// Score a candidate [start, end) by how much of the stored context still matches around it.
function score(text, anchor, start, end) {
  const before = text.slice(Math.max(0, start - CONTEXT), start);
  const after = text.slice(end, end + CONTEXT);
  const ctx = commonSuffix(before, anchor.prefix || "") + commonPrefix(after, anchor.suffix || "");
  const dist = anchor.hint == null ? 0 : Math.abs(start - anchor.hint) / (text.length + 1);
  return ctx - dist;
}

function best(text, anchor, candidates) {
  let top = null;
  for (const [s, e] of candidates) {
    const sc = score(text, anchor, s, e);
    if (!top || sc > top.score) top = { start: s, end: e, score: sc };
  }
  return top;
}

// Returns { start, end, exact } or null when the anchor can no longer be found (orphaned).
export function resolveAnchor(text, anchor) {
  if (!anchor) return null;
  const { quote = "", prefix = "", suffix = "" } = anchor;
  if (quote) {
    const found = best(text, anchor, occurrences(text, quote).map((i) => [i, i + quote.length]));
    if (found) return { start: found.start, end: found.end, exact: true };
    return null;
  }
  // Point anchor: find the spot between prefix and suffix.
  const both = occurrences(text, prefix + suffix).map((i) => [i + prefix.length, i + prefix.length]);
  let found = best(text, anchor, both);
  if (!found && prefix) {
    const p = prefix.slice(-12);
    found = best(text, anchor, occurrences(text, p).map((i) => [i + p.length, i + p.length]));
  }
  if (!found && suffix) {
    const s = suffix.slice(0, 12);
    found = best(text, anchor, occurrences(text, s).map((i) => [i, i]));
  }
  if (!found && !prefix && !suffix) return { start: 0, end: 0, exact: true };
  return found ? { start: found.start, end: found.end, exact: false } : null;
}

export function lineOf(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

// @path/to/file and #tag references inside comment text.
export function extractRefs(text) {
  const files = new Set();
  const tags = new Set();
  for (const m of text.matchAll(/(^|[\s(])@([\w./-]*[\w/])/g)) files.add(m[2]);
  for (const m of text.matchAll(/(^|[\s(])#([\w-]+)/g)) tags.add(m[2]);
  return { files: [...files], tags: [...tags] };
}
