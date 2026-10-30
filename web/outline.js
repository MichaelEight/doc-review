// The document's own structure: headings, sections, chapters, with the source offset of each, so
// the UI can list them and jump. Pure text in, plain objects out, no DOM.
//
// Markdown reads ATX (#) and setext (underlined) headings. LaTeX reads the sectioning commands.
// Plain text has no syntax to lean on, so it only takes the markers that cannot be mistaken for
// prose: an underlined line, a leading #, or a line that says "Chapter 3" in so many words. A
// chat log therefore yields nothing, which is the right answer for a chat log.

const TEX_LEVEL = { part: 1, chapter: 2, section: 3, subsection: 4, subsubsection: 5, paragraph: 6, subparagraph: 7 };
// A numeral is required, so "Part of the reason" stays prose. \b is no help here: it is ASCII,
// and there is no word boundary after the ł of "Rozdział".
const CHAPTER_WORD = /^(chapter|part|appendix|rozdzia[lł]|cz[eę][sś][cć]|dodatek)[\s.:]+[\dIVXLC]{1,7}(?=[\s.:]|$)/i;

// Inline markup in a heading is noise in a list of headings.
function plain(s) {
  return String(s)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_~`]+/g, "")
    .replace(/\\(?:emph|textbf|textit|texttt|text)\{([^{}]*)\}/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

// The {...} that follows `at`, honouring nesting, after skipping a [short title].
function braced(text, at) {
  let i = at;
  if (text[i] === "*") i++;
  if (text[i] === "[") {
    let depth = 1;
    for (i++; i < text.length && depth; i++) {
      if (text[i] === "[") depth++;
      else if (text[i] === "]") depth--;
    }
  }
  if (text[i] !== "{") return null;
  let depth = 1;
  const from = ++i;
  for (; i < text.length && depth; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === "{") depth++;
    else if (text[i] === "}") depth--;
  }
  return depth ? null : { title: text.slice(from, i - 1), end: i };
}

function lineStarts(text) {
  const out = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") out.push(i + 1);
  return out;
}

function markdownOutline(text, loose) {
  const starts = lineStarts(text);
  const lines = text.split("\n");
  const out = [];
  let fence = null;
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k];
    const f = /^\s{0,3}(```+|~~~+)/.exec(line);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (line.trimStart().startsWith(fence)) fence = null;
      continue;
    }
    if (fence) continue;
    const atx = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (atx) {
      const title = plain(atx[2]);
      if (title) out.push({ level: atx[1].length, title, start: starts[k] });
      continue;
    }
    // Setext: text with === or --- directly under it.
    const under = /^\s{0,3}(=+|-+)\s*$/.exec(lines[k + 1] || "");
    if (under && line.trim() && !/^\s{0,3}([-*+>]|\d+[.)])\s/.test(line)) {
      const title = plain(line);
      if (title) out.push({ level: under[1][0] === "=" ? 1 : 2, title, start: starts[k] });
      continue;
    }
    if (loose) {
      const ch = CHAPTER_WORD.exec(line.trim());
      if (ch && line.trim().length <= 80) out.push({ level: 2, title: plain(line), start: starts[k] });
    }
  }
  return out;
}

function texOutline(text) {
  const out = [];
  const re = /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph|title)\b/g;
  let m;
  while ((m = re.exec(text))) {
    // A sectioning command inside a comment is not a section.
    const lineAt = text.lastIndexOf("\n", m.index) + 1;
    if (/(^|[^\\])%/.test(text.slice(lineAt, m.index))) continue;
    const b = braced(text, m.index + m[0].length);
    if (!b) continue;
    const title = plain(b.title);
    if (title) out.push({ level: m[1] === "title" ? 0 : TEX_LEVEL[m[1]], title, start: m.index });
    re.lastIndex = b.end;
  }
  return out;
}

// kind: "md" | "tex" | "txt". Levels come back normalised so the shallowest heading is 1, which
// keeps the indentation sane in a document that starts at ## or uses \subsection throughout.
export function outlineOf(text, kind) {
  const raw = kind === "tex" ? texOutline(text) : markdownOutline(text, kind === "txt");
  if (!raw.length) return [];
  const top = Math.min(...raw.map((h) => h.level));
  return raw
    .sort((a, b) => a.start - b.start)
    .map((h, i, all) => ({
      ...h,
      level: h.level - top + 1,
      end: i + 1 < all.length ? all[i + 1].start : text.length,
    }));
}

// The last heading at or above `pos`, for showing where the reader is.
export function headingAt(outline, pos) {
  let hit = null;
  for (const h of outline) {
    if (h.start > pos) break;
    hit = h;
  }
  return hit;
}
