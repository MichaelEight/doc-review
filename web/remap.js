// Carry comment ranges through an edit (typing in the editor, or the AI rewriting the file) so
// threads stay on the text they were about instead of turning orphaned.
import { diffLines, diffWords, splitLines } from "./diff.js";

function lineStarts(lines) {
  const out = [0];
  for (const l of lines) out.push(out[out.length - 1] + l.length);
  return out;
}

// Returns map(offset, side) -> new offset; side "start" | "end" decides where a position inside a
// rewritten region lands.
export function offsetMapper(oldText, newText) {
  if (oldText === newText) return (x) => x;
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const as = lineStarts(a);
  const bs = lineStarts(b);
  const hunks = diffLines(oldText, newText);
  return (x, side = "start") => {
    let li = 0;
    while (li < a.length && as[li + 1] <= x) li++;
    if (x >= oldText.length) li = a.length;
    let shift = 0;
    for (const h of hunks) {
      if (li < h.aStart) break;
      if (li < h.aEnd) {
        // Inside a changed hunk: follow the word diff of the old and new hunk text, so a position
        // on words that survived the rewrite stays on them.
        const o = h.removed.join("");
        const n = h.added.join("");
        const col = x - as[h.aStart];
        let op = 0;
        let np = 0;
        for (const part of diffWords(o, n)) {
          const len = part.s.length;
          if (part.t === "=") {
            if (col >= op && col < op + len) return bs[h.bStart] + np + (col - op);
            op += len;
            np += len;
          } else if (part.t === "-") {
            if (col >= op && col < op + len) return bs[h.bStart] + np;
            op += len;
          } else np += len;
        }
        if (col >= op) return bs[h.bStart] + n.length;
        return side === "end" ? bs[h.bEnd] - (h.bEnd > h.bStart && /\n$/.test(b[h.bEnd - 1]) ? 1 : 0) : bs[h.bStart];
      }
      shift = h.bEnd - h.aEnd;
    }
    const nl = li + shift;
    const col = x - (as[li] ?? oldText.length);
    return Math.min(newText.length, (bs[nl] ?? newText.length) + col);
  };
}

export function mapRange(map, start, end) {
  if (start === end) {
    const p = map(start, "start");
    return { start: p, end: p };
  }
  const s = map(start, "start");
  const e = Math.max(s, map(end, "end"));
  return { start: s, end: e };
}
