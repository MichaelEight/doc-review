// Small Markdown parser that keeps source positions. Every piece of visible text is a "run"
// { run: text, s } whose characters map 1:1 to source offsets s, s+1, ... so a selection in the
// rendered page maps back to an exact range in the file. Elements carry { s, e } source spans.
//
// Covers: ATX headings, paragraphs, emphasis/strong/strike, inline code, links, images, autolinks,
// <u>/<sup>/<sub>/<mark>/<br>, blockquotes, nested lists, task lists, fenced code, hr, GFM tables,
// $inline$ and $$display$$ math.

const el = (tag, s, e, children = [], attrs = {}) => ({ tag, s, e, children, ...attrs });

// ---------- inline ----------

// A mapped string: s (text) and m (source offset of each char).
function mapped(lines) {
  let text = "";
  const m = [];
  lines.forEach((l, i) => {
    text += l.t;
    for (let k = 0; k < l.t.length; k++) m.push(l.o + k);
    if (i < lines.length - 1) {
      text += "\n";
      m.push(l.o + l.t.length);
    }
  });
  m.push(lines.length ? lines[lines.length - 1].o + lines[lines.length - 1].t.length : 0);
  return { text, m };
}

function pushRuns(out, str, m, a, b) {
  let i = a;
  while (i < b) {
    let j = i + 1;
    while (j < b && m[j] === m[j - 1] + 1) j++;
    out.push({ run: str.slice(i, j), s: m[i] });
    i = j;
  }
}

const PUNCT = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
const INLINE_HTML = ["u", "sup", "sub", "mark", "ins", "del", "s", "b", "i", "em", "strong", "kbd", "small"];

function findClose(str, from, b, delim, needWordEnd) {
  let i = from;
  while (i <= b - delim.length) {
    if (str[i] === "\\") {
      i += 2;
      continue;
    }
    if (str[i] === "`") {
      const n = /^`+/.exec(str.slice(i))[0].length;
      const close = str.indexOf("`".repeat(n), i + n);
      if (close > 0 && close < b) {
        i = close + n;
        continue;
      }
    }
    if (str.startsWith(delim, i) && !/\s/.test(str[i - 1] || " ")) {
      if (delim.length === 1 && str[i + 1] === delim) {
        // Skip a double delimiter when looking for a single one ("*a **b** c*").
        const inner = findClose(str, i + 2, b, delim + delim, needWordEnd);
        if (inner > 0) {
          i = inner + 2;
          continue;
        }
      }
      if (!needWordEnd || !/[\p{L}\p{N}]/u.test(str[i + delim.length] || " ")) return i;
    }
    i++;
  }
  return -1;
}

function matchBracket(str, i, b) {
  let depth = 0;
  for (let k = i; k < b; k++) {
    if (str[k] === "\\") k++;
    else if (str[k] === "[") depth++;
    else if (str[k] === "]" && --depth === 0) return k;
  }
  return -1;
}

export function parseInline(str, m, a = 0, b = str.length) {
  const out = [];
  let i = a;
  let textStart = a;
  const flush = (end) => {
    if (end > textStart) pushRuns(out, str, m, textStart, end);
  };
  while (i < b) {
    const c = str[i];
    // Escapes: the visible char maps to the char after the backslash.
    if (c === "\\" && i + 1 < b && PUNCT.includes(str[i + 1])) {
      flush(i);
      out.push({ run: str[i + 1], s: m[i + 1] });
      i += 2;
      textStart = i;
      continue;
    }
    if (c === "`") {
      const n = /^`+/.exec(str.slice(i, b))[0].length;
      const close = str.indexOf("`".repeat(n), i + n);
      if (close > 0 && close + n <= b) {
        flush(i);
        const node = el("code", m[i], m[close + n - 1] + 1);
        pushRuns(node.children, str, m, i + n, close);
        out.push(node);
        i = close + n;
        textStart = i;
        continue;
      }
    }
    if (c === "$" && str[i + 1] !== "$" && str[i + 1] && !/\s/.test(str[i + 1])) {
      let close = i + 1;
      while ((close = str.indexOf("$", close)) > 0 && close < b && (str[close - 1] === "\\" || /\s/.test(str[close - 1]))) close++;
      if (close > i + 1 && close < b && !/\d/.test(str[close + 1] || "")) {
        flush(i);
        out.push(el("math", m[i], m[close] + 1, [], { tex: str.slice(i + 1, close), display: false }));
        i = close + 1;
        textStart = i;
        continue;
      }
    }
    if ((c === "!" && str[i + 1] === "[") || c === "[") {
      const open = c === "!" ? i + 1 : i;
      const close = matchBracket(str, open, b);
      if (close > 0 && str[close + 1] === "(") {
        const end = str.indexOf(")", close + 2);
        if (end > 0 && end < b) {
          const target = str.slice(close + 2, end).trim();
          const [href, ...titleParts] = target.split(/\s+(?=")/);
          flush(i);
          if (c === "!") {
            out.push(el("img", m[i], m[end] + 1, [], { src: href.replace(/^<|>$/g, ""), alt: str.slice(open + 1, close), title: titleParts.join(" ").replace(/^"|"$/g, "") }));
          } else {
            out.push(el("a", m[i], m[end] + 1, parseInline(str, m, open + 1, close), { href: href.replace(/^<|>$/g, "") }));
          }
          i = end + 1;
          textStart = i;
          continue;
        }
      }
    }
    if (c === "<") {
      const tag = /^<(\/?)([a-z]+)\s*(\/?)>/i.exec(str.slice(i, b));
      if (tag && tag[2].toLowerCase() === "br") {
        flush(i);
        out.push(el("br", m[i], m[i + tag[0].length - 1] + 1));
        i += tag[0].length;
        textStart = i;
        continue;
      }
      if (tag && !tag[1] && INLINE_HTML.includes(tag[2].toLowerCase())) {
        const name = tag[2].toLowerCase();
        const closeTag = `</${name}>`;
        const close = str.toLowerCase().indexOf(closeTag, i + tag[0].length);
        if (close > 0 && close < b) {
          flush(i);
          out.push(el(name, m[i], m[close + closeTag.length - 1] + 1, parseInline(str, m, i + tag[0].length, close)));
          i = close + closeTag.length;
          textStart = i;
          continue;
        }
      }
    }
    if (c === "h" && /^https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/.test(str.slice(i, b)) && (i === a || /[\s(]/.test(str[i - 1]))) {
      const url = /^https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"]/.exec(str.slice(i, b))[0];
      flush(i);
      const node = el("a", m[i], m[i + url.length - 1] + 1, [], { href: url });
      pushRuns(node.children, str, m, i, i + url.length);
      out.push(node);
      i += url.length;
      textStart = i;
      continue;
    }
    if (c === "*" || c === "_" || c === "~") {
      const dbl = str[i + 1] === c;
      if (c === "~" && !dbl) {
        i++;
        continue;
      }
      const delim = dbl ? c + c : c;
      const intraword = c === "_" && /[\p{L}\p{N}]/u.test(str[i - 1] || " ");
      const next = str[i + delim.length];
      if (!intraword && next && !/\s/.test(next)) {
        const close = findClose(str, i + delim.length + 1, b, delim, c === "_");
        if (close > 0) {
          flush(i);
          const tag = c === "~" ? "del" : dbl ? "strong" : "em";
          out.push(el(tag, m[i], m[close + delim.length - 1] + 1, parseInline(str, m, i + delim.length, close)));
          i = close + delim.length;
          textStart = i;
          continue;
        }
      }
    }
    if (c === "\n" && str[i - 1] === " " && str[i - 2] === " ") {
      flush(i);
      out.push(el("br", m[i], m[i] + 1));
      i++;
      textStart = i;
      continue;
    }
    i++;
  }
  flush(b);
  return out;
}

function inline(lines) {
  const { text, m } = mapped(lines);
  return parseInline(text, m);
}

// ---------- blocks ----------

const RE = {
  fence: /^(\s{0,3})(`{3,}|~{3,})\s*([\w+-]*)/,
  heading: /^\s{0,3}(#{1,6})(\s+|$)/,
  hr: /^\s{0,3}([-*_])(\s*\1){2,}\s*$/,
  quote: /^\s{0,3}>\s?/,
  list: /^(\s*)([-*+]|\d{1,9}[.)])(\s+|$)/,
  mathOpen: /^\s{0,3}\$\$/,
  tableSep: /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/,
};

const blank = (l) => !l.t.trim();
const cut = (l, n) => ({ t: l.t.slice(n), o: l.o + n });
const lineEnd = (l) => l.o + l.t.length;

function startsBlock(l, next) {
  return RE.fence.test(l.t) || RE.heading.test(l.t) || RE.hr.test(l.t) || RE.quote.test(l.t) || RE.list.test(l.t) || RE.mathOpen.test(l.t) ||
    (next && l.t.includes("|") && RE.tableSep.test(next.t) && next.t.includes("-"));
}

function splitCells(l) {
  const cells = [];
  let t = l.t;
  let o = l.o;
  const lead = /^\s*\|?/.exec(t)[0].length;
  t = t.slice(lead);
  o += lead;
  let start = 0;
  for (let k = 0; k <= t.length; k++) {
    if (k === t.length || (t[k] === "|" && t[k - 1] !== "\\")) {
      const raw = t.slice(start, k);
      const ls = raw.length - raw.trimStart().length;
      const cell = raw.trim();
      if (k < t.length || cell) cells.push({ t: cell, o: o + start + ls });
      start = k + 1;
    }
  }
  return cells;
}

export function parseBlocks(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (blank(l)) {
      i++;
      continue;
    }
    let mm;
    if ((mm = RE.fence.exec(l.t))) {
      const fence = mm[2];
      const body = [];
      let j = i + 1;
      while (j < lines.length && !lines[j].t.trimStart().startsWith(fence)) body.push(lines[j++]);
      const end = j < lines.length ? lineEnd(lines[j]) : lineEnd(lines[j - 1] ?? l);
      const code = el("code", body[0]?.o ?? lineEnd(l), end, [], { lang: mm[3] });
      body.forEach((b, k) => {
        if (b.t) code.children.push({ run: b.t, s: b.o });
        if (k < body.length - 1) code.children.push({ run: "\n", s: lineEnd(b) });
      });
      out.push(el("pre", l.o, end, [code]));
      i = j + 1;
      continue;
    }
    if (RE.mathOpen.test(l.t)) {
      const startCol = l.t.indexOf("$$");
      const rest = l.t.slice(startCol + 2);
      let tex = "";
      let j = i;
      let end;
      if (rest.includes("$$")) {
        tex = rest.slice(0, rest.indexOf("$$"));
        end = l.o + startCol + 2 + rest.indexOf("$$") + 2;
      } else {
        const parts = [rest];
        j = i + 1;
        while (j < lines.length && !lines[j].t.includes("$$")) parts.push(lines[j++].t);
        if (j < lines.length) parts.push(lines[j].t.slice(0, lines[j].t.indexOf("$$")));
        tex = parts.join("\n");
        end = j < lines.length ? lines[j].o + lines[j].t.indexOf("$$") + 2 : lineEnd(lines[lines.length - 1]);
      }
      out.push(el("math", l.o, end, [], { tex: tex.trim(), display: true }));
      i = j + 1;
      continue;
    }
    if ((mm = RE.heading.exec(l.t))) {
      const level = mm[1].length;
      const content = cut(l, mm[0].length);
      content.t = content.t.replace(/\s+#+\s*$/, "").replace(/\s+$/, "");
      out.push(el("h" + level, l.o, lineEnd(l), inline([content])));
      i++;
      continue;
    }
    if (RE.hr.test(l.t)) {
      out.push(el("hr", l.o, lineEnd(l)));
      i++;
      continue;
    }
    if (RE.quote.test(l.t)) {
      const inner = [];
      let j = i;
      while (j < lines.length && (RE.quote.test(lines[j].t) || (!blank(lines[j]) && inner.length && !startsBlock(lines[j])))) {
        const q = RE.quote.exec(lines[j].t);
        inner.push(q ? cut(lines[j], q[0].length) : lines[j]);
        j++;
      }
      out.push(el("blockquote", l.o, lineEnd(lines[j - 1]), parseBlocks(inner)));
      i = j;
      continue;
    }
    if ((mm = RE.list.exec(l.t))) {
      const indent = mm[1].length;
      const ordered = /\d/.test(mm[2]);
      const list = el(ordered ? "ol" : "ul", l.o, l.o, [], ordered ? { start: parseInt(mm[2], 10) } : {});
      let j = i;
      while (j < lines.length) {
        const im = RE.list.exec(lines[j].t);
        if (!im || im[1].length !== indent || /\d/.test(im[2]) !== ordered) break;
        const contentCol = im[0].length;
        const item = [cut(lines[j], contentCol)];
        let k = j + 1;
        while (k < lines.length) {
          const t = lines[k];
          const ind = t.t.length - t.t.trimStart().length;
          if (blank(t)) {
            const nx = lines[k + 1];
            if (nx && !blank(nx) && nx.t.length - nx.t.trimStart().length > indent) {
              item.push({ t: "", o: t.o });
              k++;
              continue;
            }
            break;
          }
          if (ind > indent) item.push(cut(t, Math.min(ind, contentCol)));
          else if (!startsBlock(t) && !blank(lines[k - 1])) item.push(cut(t, ind));
          else break;
          k++;
        }
        const li = el("li", lines[j].o, lineEnd(lines[k - 1]), []);
        const task = /^\[([ xX])\]\s+/.exec(item[0].t);
        if (task) {
          li.task = task[1] !== " ";
          li.taskAt = item[0].o + 1;
          item[0] = cut(item[0], task[0].length);
        }
        // A tight item (one paragraph) renders inline, not wrapped in <p>.
        const blocks = parseBlocks(item);
        li.children = blocks.length === 1 && blocks[0].tag === "p" ? blocks[0].children : blocks;
        list.children.push(li);
        j = k;
        while (j < lines.length && blank(lines[j]) && lines[j + 1] && RE.list.exec(lines[j + 1].t)?.[1].length === indent) j++;
      }
      list.e = lineEnd(lines[j - 1]);
      out.push(list);
      i = j;
      continue;
    }
    const next = lines[i + 1];
    if (next && l.t.includes("|") && next.t.includes("-") && RE.tableSep.test(next.t)) {
      const aligns = splitCells(next).map((c) => (c.t.startsWith(":") && c.t.endsWith(":") ? "center" : c.t.endsWith(":") ? "right" : c.t.startsWith(":") ? "left" : ""));
      const table = el("table", l.o, l.o);
      const row = (line, cellTag) => el("tr", line.o, lineEnd(line), splitCells(line).map((c, k) => el(cellTag, c.o, c.o + c.t.length, inline([c]), { align: aligns[k] })));
      table.children.push(el("thead", l.o, lineEnd(l), [row(l, "th")]));
      const body = el("tbody", next.o, next.o);
      let j = i + 2;
      while (j < lines.length && !blank(lines[j]) && lines[j].t.includes("|")) body.children.push(row(lines[j++], "td"));
      body.e = lineEnd(lines[j - 1]);
      if (body.children.length) table.children.push(body);
      table.e = lineEnd(lines[j - 1]);
      out.push(table);
      i = j;
      continue;
    }
    // Paragraph.
    const para = [l];
    let j = i + 1;
    while (j < lines.length && !blank(lines[j]) && !startsBlock(lines[j], lines[j + 1])) para.push(lines[j++]);
    const p = para.map((x, k) => (k === 0 ? cut(x, x.t.length - x.t.trimStart().length) : x));
    out.push(el("p", l.o, lineEnd(para[para.length - 1]), inline(p)));
    i = j;
  }
  return out;
}

export function toLines(src) {
  const lines = [];
  let o = 0;
  for (const t of src.split("\n")) {
    lines.push({ t: t.endsWith("\r") ? t.slice(0, -1) : t, o });
    o += t.length + 1;
  }
  return lines;
}

export function parseMarkdown(src) {
  return { tag: "root", s: 0, e: src.length, children: parseBlocks(toLines(src)) };
}

// Plain text view: one run per line so selections map exactly.
export function parsePlain(src) {
  const lines = toLines(src);
  const code = el("div", 0, src.length);
  lines.forEach((l, k) => {
    if (l.t) code.children.push({ run: l.t, s: l.o });
    if (k < lines.length - 1) code.children.push({ run: "\n", s: lineEnd(l) });
  });
  return { tag: "root", s: 0, e: src.length, children: [code] };
}
