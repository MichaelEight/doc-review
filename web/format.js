// Formatting commands for the editor and the reading view. Each returns an edit
// { from, to, insert, selStart, selEnd } so the textarea can apply it through insertText (which keeps
// native undo) and the reading view can apply it to the string directly.

export const MARKERS = {
  md: {
    bold: ["**", "**"], italic: ["*", "*"], underline: ["<u>", "</u>"], strike: ["~~", "~~"], code: ["`", "`"],
  },
  tex: {
    bold: ["\\textbf{", "}"], italic: ["\\textit{", "}"], underline: ["\\underline{", "}"], strike: ["\\sout{", "}"], code: ["\\texttt{", "}"],
  },
  txt: {},
};

export function toggleWrap(text, start, end, [L, R]) {
  const sel = text.slice(start, end);
  const single = L.length === 1;
  // Markers just outside the selection: unwrap. For "*", don't eat half of a "**".
  const outside = text.slice(start - L.length, start) === L && text.slice(end, end + R.length) === R &&
    !(single && text[start - 2] === L && text[start - 3] !== L);
  if (outside) {
    return { from: start - L.length, to: end + R.length, insert: sel, selStart: start - L.length, selEnd: end - L.length };
  }
  if (sel.length >= L.length + R.length && sel.startsWith(L) && sel.endsWith(R) && !(single && sel.startsWith(L + L))) {
    const inner = sel.slice(L.length, sel.length - R.length);
    return { from: start, to: end, insert: inner, selStart: start, selEnd: start + inner.length };
  }
  // Keep surrounding whitespace outside the markers ("word " -> "**word** ").
  const lead = sel.length - sel.trimStart().length;
  const trail = sel.length - sel.trimEnd().length;
  const core = sel.slice(lead, sel.length - trail);
  const insert = sel.slice(0, lead) + L + core + R + sel.slice(sel.length - trail);
  return { from: start, to: end, insert, selStart: start + lead + L.length, selEnd: start + lead + L.length + core.length };
}

export function link(text, start, end, kind) {
  const sel = text.slice(start, end) || "link";
  if (kind === "tex") {
    const insert = `\\href{https://}{${sel}}`;
    return { from: start, to: end, insert, selStart: start + 6, selEnd: start + 14 };
  }
  const insert = `[${sel}](https://)`;
  return { from: start, to: end, insert, selStart: start + sel.length + 3, selEnd: start + sel.length + 11 };
}

function lineSpan(text, start, end) {
  const from = text.lastIndexOf("\n", start - 1) + 1;
  let to = text.indexOf("\n", Math.max(end - (end > start && text[end - 1] === "\n" ? 1 : 0), start));
  if (to < 0) to = text.length;
  return { from, to };
}

// Apply fn to every selected line; the selection grows to whole lines.
function mapLines(text, start, end, fn) {
  const { from, to } = lineSpan(text, start, end);
  const lines = text.slice(from, to).split("\n");
  const insert = lines.map(fn).join("\n");
  return { from, to, insert, selStart: from, selEnd: from + insert.length };
}

export function heading(text, start, end, level) {
  return mapLines(text, start, end, (l) => {
    const m = /^(#{1,6})\s+/.exec(l);
    const body = m ? l.slice(m[0].length) : l;
    return m && m[1].length === level ? body : "#".repeat(level) + " " + body;
  });
}

export function listToggle(text, start, end, ordered) {
  const { from, to } = lineSpan(text, start, end);
  const lines = text.slice(from, to).split("\n");
  const re = ordered ? /^(\s*)\d+[.)]\s+/ : /^(\s*)[-*+]\s+/;
  const all = lines.every((l) => !l.trim() || re.test(l));
  let n = 0;
  return mapLines(text, start, end, (l) => {
    if (!l.trim()) return l;
    if (all) return l.replace(re, "$1");
    n++;
    return (ordered ? `${n}. ` : "- ") + l.replace(/^(\s*)([-*+]|\d+[.)])\s+/, "");
  });
}

export function indent(text, start, end, out) {
  if (!out && start === end) return { from: start, to: end, insert: "  ", selStart: start + 2, selEnd: start + 2 };
  return mapLines(text, start, end, (l) => (out ? l.replace(/^( {1,2}|\t)/, "") : "  " + l));
}

// Map a keydown to a command name, or null.
export function shortcut(e) {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return e.key === "Tab" ? (e.shiftKey ? "outdent" : "indent") : null;
  const k = e.key.toLowerCase();
  if (e.altKey && (k === "m" || e.code === "KeyM")) return "comment";
  if (e.altKey && /^Digit[1-3]$/.test(e.code)) return "h" + e.code.slice(-1);
  if (e.shiftKey && (k === "x" || e.code === "KeyX")) return "strike";
  if (e.shiftKey && e.code === "Digit8") return "ul";
  if (e.shiftKey && e.code === "Digit7") return "ol";
  if (e.shiftKey && e.key === "Enter") return "send";
  if (e.shiftKey || e.altKey) return null;
  return { b: "bold", i: "italic", u: "underline", e: "code", k: "link", s: "save" }[k] ?? null;
}

export function command(name, text, start, end, kind) {
  const m = MARKERS[kind] || {};
  if (m[name]) return toggleWrap(text, start, end, m[name]);
  if (name === "link" && kind !== "txt") return link(text, start, end, kind);
  if (kind === "md" && /^h[1-3]$/.test(name)) return heading(text, start, end, Number(name[1]));
  if (kind === "md" && (name === "ul" || name === "ol")) return listToggle(text, start, end, name === "ol");
  if (name === "indent" || name === "outdent") return indent(text, start, end, name === "outdent");
  return null;
}
