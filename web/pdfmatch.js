// Map text the user selected in the rendered PDF back to a range in the LaTeX source. SyncTeX
// only knows lines, and the rendered text differs from the source (macros, math, ligatures,
// hyphenation), so: search the SyncTeX lines (plus one line of slack on each side) for the
// selected words in order with markup allowed between them; failing that, span from the first to
// the last word that does occur; failing that, take the lines themselves.

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function lineStart(lines, n) {
  let off = 0;
  for (let i = 0; i < n - 1 && i < lines.length; i++) off += lines[i].length + 1;
  return off;
}

export function pdfWords(quote) {
  return String(quote)
    .normalize("NFKC")
    .replace(/(\p{L})-\s+(\p{L})/gu, "$1$2")
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(Boolean);
}

// la, lb: 1-based source lines SyncTeX gave for the selection's start and end.
export function matchInSource(text, quote, la, lb) {
  const lines = text.split("\n");
  const lo = Math.max(1, Math.min(la, lb) - 1);
  const hi = Math.min(lines.length, Math.max(la, lb) + 1);
  const off = lineStart(lines, lo);
  const win = lines.slice(lo - 1, hi).join("\n");
  const words = pdfWords(quote);
  if (words.length) {
    const all = new RegExp(words.map(escRe).join("[\\s\\S]{0,60}?"), "u").exec(win);
    if (all) return { start: off + all.index, end: off + all.index + all[0].length, exact: true };
    let i = -1;
    let first = null;
    for (const w of words) if ((i = win.indexOf(w)) >= 0) {
      first = w;
      break;
    }
    if (first) {
      for (const w of [...words].reverse()) {
        const j = win.lastIndexOf(w);
        if (j >= i) return { start: off + i, end: off + j + w.length, exact: false };
      }
    }
  }
  const a = Math.min(la, lb);
  const b = Math.min(lines.length, Math.max(la, lb));
  let start = lineStart(lines, a);
  const end = lineStart(lines, b) + (lines[b - 1] || "").length;
  while (start < end && /\s/.test(text[start])) start++;
  return { start, end, exact: false };
}

// A click on a word in the PDF -> source offset of that word on the SyncTeX line (or the line's
// first character).
export function pointInSource(text, word, line) {
  const lines = text.split("\n");
  const n = Math.min(Math.max(1, line), lines.length);
  const w = pdfWords(word)[0];
  for (const l of [n, n - 1, n + 1]) {
    if (!w || l < 1 || l > lines.length) continue;
    const i = lines[l - 1].indexOf(w);
    if (i >= 0) return lineStart(lines, l) + i;
  }
  const s = lineStart(lines, n);
  return s + ((lines[n - 1] || "").match(/^\s*/)[0].length);
}
