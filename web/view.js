// Turns a parsed tree into DOM where every text segment knows its source offset, overlays comment
// highlights, and maps DOM selections back to source ranges. Also builds the syntax-tinted
// backdrop that sits under the source editor's textarea.

const katexCache = new Map();

function renderMath(tex, display) {
  const key = (display ? "D" : "I") + tex;
  if (katexCache.has(key)) return katexCache.get(key);
  let html = null;
  if (window.katex) {
    try {
      html = window.katex.renderToString(tex, { displayMode: display, throwOnError: false, output: "html" });
    } catch {
      html = null;
    }
  }
  if (html) katexCache.set(key, html);
  return html;
}

function cover(ranges, a, b) {
  // Ids of non-empty ranges covering [a, b).
  const ids = [];
  for (const r of ranges) if (r.start < r.end && r.start < b && r.end > a) ids.push(r);
  return ids;
}

function segClass(rs) {
  if (!rs.length) return "seg";
  const kinds = new Set(rs.map((r) => r.kind));
  return "seg hl" + [...kinds].map((k) => " hl-" + k).join("") + (rs.length > 1 ? " hl-multi" : "");
}

function runToNodes(run, ranges, pins) {
  const a = run.s;
  const b = run.s + run.run.length;
  const cuts = new Set([0, run.run.length]);
  for (const r of ranges) {
    if (r.start > a && r.start < b) cuts.add(r.start - a);
    if (r.end > a && r.end < b) cuts.add(r.end - a);
  }
  const here = pins.filter((p) => !p.placed && p.pos >= a && p.pos <= b);
  for (const p of here) cuts.add(p.pos - a);
  const pts = [...cuts].sort((x, y) => x - y);
  const out = [];
  for (let k = 0; k < pts.length; k++) {
    for (const p of here) {
      if (!p.placed && p.pos - a === pts[k]) {
        p.placed = true;
        out.push(pinEl(p));
      }
    }
    if (k === pts.length - 1) break;
    const s = a + pts[k];
    const e = a + pts[k + 1];
    const span = document.createElement("span");
    const rs = cover(ranges, s, e);
    span.className = segClass(rs);
    if (rs.length) span.dataset.ids = rs.map((r) => r.id).join(" ");
    span.dataset.s = s;
    span.textContent = run.run.slice(pts[k], pts[k + 1]);
    out.push(span);
  }
  return out;
}

function pinEl(p) {
  const s = document.createElement("span");
  s.className = `pin pin-${p.kind}`;
  s.dataset.id = p.id;
  s.dataset.s = p.pos;
  return s;
}

const SAFE_URL = /^(https?:|mailto:|#|\.{0,2}\/|[\w./%-]+$)/i;

function build(node, ctx) {
  if (node.run != null) return runToNodes(node, ctx.ranges, ctx.pins);
  const { tag } = node;
  let dom;
  if (tag === "math") {
    dom = document.createElement(node.display ? "div" : "span");
    dom.className = node.display ? "math math-display" : "math";
    const html = renderMath(node.tex, node.display);
    if (html) dom.innerHTML = html;
    else dom.textContent = node.display ? `$$${node.tex}$$` : `$${node.tex}$`;
    dom.dataset.atom = "1";
  } else if (tag === "img") {
    dom = document.createElement("img");
    const src = node.src;
    dom.src = /^(https?:|data:)/.test(src) ? src : ctx.rawUrl(src);
    dom.alt = node.alt || "";
    if (node.title) dom.title = node.title;
    dom.dataset.atom = "1";
    dom.loading = "lazy";
  } else if (tag === "root") {
    dom = document.createDocumentFragment();
    for (const c of node.children) dom.append(build(c, ctx));
  } else {
    dom = document.createElement(tag);
    if (tag === "a") {
      dom.href = SAFE_URL.test(node.href) ? node.href : "#";
      dom.target = "_blank";
      dom.rel = "noopener noreferrer";
    }
    if (node.start && node.start !== 1) dom.start = node.start;
    if (node.align) dom.style.textAlign = node.align;
    if (node.task != null) {
      dom.className = "task";
      const box = document.createElement("span");
      box.className = "taskbox" + (node.task ? " done" : "");
      box.dataset.taskAt = node.taskAt;
      dom.append(box);
    }
    for (const c of node.children) {
      const r = build(c, ctx);
      if (Array.isArray(r)) dom.append(...r);
      else dom.append(r);
    }
  }
  if (dom.dataset) {
    dom.dataset.s = node.s;
    dom.dataset.e = node.e;
    if (dom.dataset.atom) {
      const rs = cover(ctx.ranges, node.s, node.e);
      if (rs.length) {
        dom.classList.add("hl", ...new Set(rs.map((r) => "hl-" + r.kind)));
        dom.dataset.ids = rs.map((r) => r.id).join(" ");
      }
    }
  }
  return dom;
}

// threads: [{ id, start, end, kind }] already resolved against the current text.
export function renderTree(tree, threads, rawUrl) {
  const ranges = threads.filter((t) => t.end > t.start);
  const pins = threads.filter((t) => t.end === t.start).map((t) => ({ id: t.id, pos: t.start, kind: t.kind, placed: false }));
  const frag = build(tree, { ranges, pins, rawUrl });
  const root = document.createElement("div");
  root.append(frag);
  // Point comments between blocks: put the pin before the first block that starts after it.
  for (const p of pins) {
    if (p.placed) continue;
    const blocks = [...root.children];
    const after = blocks.find((b) => Number(b.dataset.s) >= p.pos);
    const pin = pinEl(p);
    pin.classList.add("pin-block");
    if (after) root.insertBefore(pin, after);
    else root.append(pin);
  }
  return root;
}

// ---------- DOM point -> source offset ----------

export function pointToSource(container, node, offset, side = "start") {
  if (node.nodeType === Node.TEXT_NODE) {
    const seg = node.parentElement;
    if (seg?.classList.contains("seg")) return Number(seg.dataset.s) + offset;
  }
  const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  const atom = el?.closest?.("[data-atom]");
  if (atom && container.contains(atom)) return Number(side === "end" ? atom.dataset.e : atom.dataset.s);
  if (el?.classList?.contains("seg") && node === el) {
    return Number(el.dataset.s) + (offset > 0 ? el.textContent.length : 0);
  }
  const range = document.createRange();
  try {
    range.setStart(node, offset);
  } catch {
    return null;
  }
  const items = container.querySelectorAll(".seg, [data-atom], .pin");
  let last = null;
  for (const it of items) {
    if (range.comparePoint(it, 0) === 1) return Number(it.dataset.s);
    last = it;
  }
  if (!last) return 0;
  if (last.dataset.atom) return Number(last.dataset.e);
  return Number(last.dataset.s) + (last.classList.contains("seg") ? last.textContent.length : 0);
}

export function selectionToSource(container) {
  const sel = window.getSelection();
  if (!sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  if (!container.contains(r.commonAncestorContainer)) return null;
  const start = pointToSource(container, r.startContainer, r.startOffset, "start");
  const end = r.collapsed ? start : pointToSource(container, r.endContainer, r.endOffset, "end");
  if (start == null || end == null) return null;
  return { start: Math.min(start, end), end: Math.max(start, end), collapsed: r.collapsed, rect: r.getBoundingClientRect() };
}

export function caretAt(x, y) {
  if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y);
    return p ? { node: p.offsetNode, offset: p.offset } : null;
  }
  const r = document.caretRangeFromPoint?.(x, y);
  return r ? { node: r.startContainer, offset: r.startOffset } : null;
}

// ---------- source backdrop ----------

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function syntaxTokens(text, kind) {
  const toks = [];
  const add = (re, cls, group = 0) => {
    for (const m of text.matchAll(re)) {
      const off = group ? m.index + m[0].indexOf(m[group]) : m.index;
      const len = group ? m[group].length : m[0].length;
      if (len) toks.push([off, off + len, cls]);
    }
  };
  if (kind === "md") {
    add(/^#{1,6}\s.*$/gm, "sx-h");
    add(/^\s*([-*+]|\d+[.)])\s/gm, "sx-mark");
    add(/^\s*>.*$/gm, "sx-quote");
    add(/(\*\*|__|~~|(?<![*\w])\*(?!\s)|`+)/g, "sx-mark");
    add(/\$\$[\s\S]*?\$\$|\$[^\s$][^$\n]*?\$/g, "sx-math");
    add(/!?\[[^\]\n]*\]\([^)\n]*\)/g, "sx-link");
    add(/^```.*$/gm, "sx-mark");
    add(/<\/?(u|sup|sub|mark|br|kbd)\s*\/?>/g, "sx-mark");
  } else if (kind === "tex") {
    add(/\\[a-zA-Z@]+\*?|\\./g, "sx-cmd");
    add(/[{}[\]]/g, "sx-mark");
    add(/\$\$[\s\S]*?\$\$|\$[^$\n]+\$/g, "sx-math");
    add(/(?<!\\)%.*$/gm, "sx-comment");
  }
  return toks;
}

export function buildBackdrop(text, threads, kind) {
  const ranges = threads.filter((t) => t.end > t.start);
  const pins = threads.filter((t) => t.end === t.start);
  const toks = syntaxTokens(text, kind);
  const cuts = new Set([0, text.length]);
  for (const r of ranges) cuts.add(Math.min(r.start, text.length)), cuts.add(Math.min(r.end, text.length));
  for (const t of toks) cuts.add(t[0]), cuts.add(t[1]);
  for (const p of pins) cuts.add(Math.min(p.start, text.length));
  const pts = [...cuts].sort((a, b) => a - b);
  let html = "";
  let ti = 0;
  toks.sort((a, b) => a[0] - b[0]);
  for (let k = 0; k < pts.length; k++) {
    const s = pts[k];
    for (const p of pins) if (Math.min(p.start, text.length) === s) html += `<span class="pin pin-${p.kind}" data-id="${p.id}" data-s="${s}"></span>`;
    if (k === pts.length - 1) break;
    const e = pts[k + 1];
    if (e === s) continue;
    while (ti < toks.length && toks[ti][1] <= s) ti++;
    const syn = [];
    for (let j = ti; j < toks.length && toks[j][0] <= s; j++) if (toks[j][1] >= e) syn.push(toks[j][2]);
    const rs = cover(ranges, s, e);
    const cls = [...new Set(syn)].join(" ") + (rs.length ? " " + segClass(rs) : "");
    const body = esc(text.slice(s, e));
    html += cls.trim() ? `<span class="${cls.trim()}"${rs.length ? ` data-ids="${rs.map((r) => r.id).join(" ")}"` : ""}>${body}</span>` : body;
  }
  return html + "\n ";
}
