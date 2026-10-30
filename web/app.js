import { parseMarkdown, parsePlain } from "./markdown.js";
import { renderTree, selectionToSource, pointToSource, caretAt, buildBackdrop } from "./view.js";
import { rulesFor, ruleRanges, styleCss, matchesScope } from "./display.js";
import { RECIPES, findRecipe, fillPrompt, scopeGlobs } from "./recipes.js";
import { outlineOf, headingAt } from "./outline.js";
import { makeAnchor, resolveAnchor, lineOf } from "./anchor.js";
import { offsetMapper, mapRange } from "./remap.js";
import { diffLines, diffWords, acceptHunk, revertHunk, splitLines } from "./diff.js";
import { shortcut, command } from "./format.js";
import { COMMANDS, ACTION_LABEL, findCommand, parseCommand } from "./commands.js";
import { renderPdf, pageAt, toPdf, rangeRects, paintMarks, marksAt } from "./pdfview.js";
import { matchInSource, pointInSource } from "./pdfmatch.js";

// ---------- basics ----------

const qs = new URLSearchParams(location.search);
const WS = qs.get("ws");
const TOKEN = qs.get("t");
const $ = (id) => document.getElementById(id);
const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "html") e.innerHTML = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k);
  return e;
};
// replaceChildren is the raw DOM call, which turns a null child into the text "null". Use this
// wherever a child is conditional.
const fill = (el, ...kids) => el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const ICON = {
  // Both stars together are centred on the 24px box, so the glyph sits in the middle of round avatars.
  spark: '<svg viewBox="0 0 24 24"><path d="M10.5 3.5l1.8 5.2 5.2 1.8-5.2 1.8-1.8 5.2-1.8-5.2-5.2-1.8 5.2-1.8z"/><path d="M18 15.2l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  expand: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  undo: '<svg viewBox="0 0 24 24"><path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg>',
  reopen: '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
  caret: '<svg viewBox="0 0 24 24"><path d="M9.5 5.5l6.5 6.5-6.5 6.5"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
  quote: '<svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h11M4 17h7"/></svg>',
};

async function api(method, path, body) {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${path}${sep}ws=${WS}`, {
    method,
    headers: { "content-type": "application/json", "x-token": TOKEN },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || res.statusText);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}
const rawUrl = (p) => `/api/raw?ws=${WS}&t=${TOKEN}&path=${encodeURIComponent(p)}`;

// Image paths in a document are relative to that document, not to the workspace root.
function relToFile(p) {
  if (p.startsWith("/")) return p.slice(1);
  const out = (S.file || "").split("/").slice(0, -1);
  for (const part of p.split("/")) {
    if (part === "..") out.pop();
    else if (part && part !== ".") out.push(part);
  }
  return out.join("/");
}

const store = {
  get(k, d) {
    try {
      return JSON.parse(localStorage.getItem("docreview:" + k)) ?? d;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem("docreview:" + k, JSON.stringify(v));
    } catch {}
  },
};

// ---------- state ----------

const S = {
  files: [], threads: [], tags: {}, styles: [], baselines: new Set(), latex: false,
  stylePanelShut: store.get("stylePanelShut", false),
  aiWorking: false, agentWaiting: false, pending: 0,
  file: null, kind: "md", text: "", hash: null, baseline: null,
  mode: "read", active: null, draft: null, live: new Map(),
  dirty: false, saveTimer: null, undo: [], replyDrafts: new Map(),
  showResolved: store.get("showResolved", true),
  collapsed: new Set(store.get("collapsedDirs:" + WS, [])),
  wsName: "",
  chip: null,
};

const kindOf = (p) => (/\.(md|markdown)$/i.test(p) ? "md" : /\.(tex|bib)$/i.test(p) ? "tex" : "txt");
const fileThreads = () => S.threads.filter((t) => t.file === S.file);
const visibleThreads = () => fileThreads().filter((t) => S.showResolved || t.status !== "resolved" || t.id === S.active);
const hasChanges = () => S.baseline != null && S.baseline !== S.text;
const editLocked = () => S.aiWorking || hasChanges();

function threadKind(t) {
  if (t.status === "resolved") return "resolved";
  const last = t.messages[t.messages.length - 1];
  if (last?.author === "ai" && last.kind === "question") return "question";
  return t.author === "ai" ? "ai" : "user";
}

function rangesForRender() {
  const out = [];
  for (const t of visibleThreads()) {
    const r = S.live.get(t.id);
    if (r) out.push({ id: t.id, start: r.start, end: r.end, kind: threadKind(t) });
  }
  if (S.draft) out.push({ id: "draft", start: S.draft.start, end: S.draft.end, kind: "draft" });
  return out;
}

// Display-rule marks for the open file. Running every rule over the whole text on each render
// would be wasteful, so the result is kept until the text or the rules change.
let markCache = { text: null, rules: null, marks: [] };

function marksForRender() {
  const rules = S.file ? rulesFor(S.styles, S.file) : [];
  if (!rules.length) return [];
  const key = JSON.stringify(rules);
  if (markCache.text === S.text && markCache.rules === key) return markCache.marks;
  markCache = { text: S.text, rules: key, marks: ruleRanges(S.text, rules) };
  return markCache.marks;
}

function resolveAll(keepLive = false) {
  const next = new Map();
  for (const t of fileThreads()) {
    if (keepLive && S.live.has(t.id)) next.set(t.id, S.live.get(t.id));
    else {
      const r = resolveAnchor(S.text, t.anchor);
      if (r) next.set(t.id, { start: r.start, end: r.end });
    }
  }
  S.live = next;
}

// ---------- boot ----------

async function boot() {
  if (!WS || !TOKEN) {
    document.body.innerHTML = '<div class="empty"><h2>Missing workspace</h2><p>Open this page through the link the AI gave you (review_open).</p></div>';
    return;
  }
  document.body.classList.add("no-file", "mode-read");
  $("sidebar").classList.toggle("hidden", store.get("sidebarHidden", false));
  $("showResolved").checked = S.showResolved;
  await refreshState();
  connectEvents();
  const want = qs.get("file") || store.get("lastFile:" + WS, null);
  const first = S.files.find((f) => f.path === want && f.editable) || S.files.find((f) => f.editable && /readme/i.test(f.path)) || S.files.find((f) => f.editable);
  if (first) await openFile(first.path);
  wire();
  // KaTeX loads deferred; re-render math once it is there.
  if (!window.katex) window.addEventListener("load", () => S.mode === "read" && renderView());
}

async function refreshState() {
  const st = await api("GET", "/api/state");
  S.files = st.files;
  S.threads = st.threads;
  S.tags = st.tags;
  S.styles = st.styles || [];
  S.baselines = new Set(st.baselines);
  S.latex = st.latex;
  S.synctex = st.synctex;
  S.wsName = st.name;
  $("wsName").textContent = st.name;
  document.title = `${st.name} · Doc Review`;
  setStatus(st);
  renderSidebar();
}

let refreshTimer = null;
function scheduleRefresh(then) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    await refreshState().catch(() => {});
    if (S.file) {
      resolveAll(S.dirty);
      renderView();
    }
    const open = modalId && S.threads.find((t) => t.id === modalId);
    if (open) fillModal(open);
    else if (modalId) closeModal(true);
    then?.();
  }, 60);
}

function connectEvents() {
  const es = new EventSource(`/api/events?ws=${WS}&t=${TOKEN}`);
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    if (ev.type === "status") setStatus(ev);
    else if (ev.type === "threads" || ev.type === "files") scheduleRefresh();
    else if (ev.type === "file") {
      if (ev.path === S.file && !S.dirty) reloadFile();
      scheduleRefresh();
    } else if (ev.type === "round_start") {
      toast(`AI picked up ${ev.threads} comment${ev.threads === 1 ? "" : "s"}`);
    } else if (ev.type === "round_end") {
      scheduleRefresh(async () => {
        if (S.file) await reloadFile();
        const changed = [...S.baselines];
        const text = ev.summary ? `AI finished: ${ev.summary}` : "AI finished";
        if (changed.length) {
          toast(text, {
            action: "Review changes",
            onAction: async () => {
              if (!changed.includes(S.file)) await openFile(changed[0]);
              setMode("changes");
            },
            ms: 9000,
          });
        } else toast(text);
      });
    }
  };
  es.onerror = () => setStatus({ offline: true });
  es.onopen = () => scheduleRefresh();
}

function setStatus(st) {
  const pill = $("agentPill");
  pill.className = "agent-pill";
  // Four states, from the server's point of view:
  //   editing    the AI received your comments and has not finished the round
  //   listening  the AI is blocked in review_wait; Send delivers instantly
  //   away       an AI session opened this folder but is not waiting right now (busy, or talking in chat)
  //   no AI      page started with --serve; comments queue in .doc-review/ until an AI opens the folder
  const [cls, label, tip] = st.offline ? ["", "Server offline", "Lost the connection to the doc-review server."]
    : st.aiWorking ? ["working", "AI editing", "The AI is working on the comments you sent. Editing is paused until it finishes."]
    : st.agentWaiting ? ["listening", "AI listening", "The AI is waiting. Send to AI delivers your comments right away."]
    : st.agentAttached ? ["away", "AI away", "An AI session has this folder open but is not waiting for comments right now. Anything you send is queued and delivered when it listens again."]
    : ["", "No AI session", "This page was opened without an AI. Comments you send are saved in the folder and delivered when an AI opens it with doc-review."];
  if (cls) pill.classList.add(cls);
  pill.querySelector("span").textContent = label;
  pill.title = tip;
  if (st.offline) return;
  const wasWorking = S.aiWorking;
  S.aiWorking = !!st.aiWorking;
  S.agentWaiting = !!st.agentWaiting;
  S.pending = st.pending ?? 0;
  $("sendCount").textContent = S.pending ? String(S.pending) : "";
  $("sendBtn").disabled = !S.pending;
  $("workBanner").classList.toggle("on", S.aiWorking);
  if (wasWorking !== S.aiWorking) updateLock();
}

// ---------- sidebar ----------

const dirOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

// Editable files grouped by their folder, in the order the server walked them.
function fileGroups(files) {
  const groups = new Map();
  for (const f of files) {
    const d = dirOf(f.path);
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d).push(f);
  }
  return groups;
}

const allDirs = () => [...fileGroups(S.files.filter((f) => f.editable)).keys()];

function setCollapsed(dirs) {
  S.collapsed = new Set(dirs);
  store.set("collapsedDirs:" + WS, [...S.collapsed]);
  renderSidebar();
}

function toggleDir(d) {
  const next = new Set(S.collapsed);
  next.has(d) ? next.delete(d) : next.add(d);
  setCollapsed(next);
}

// The file list is rebuilt on every refresh, which would throw the scroll back to the top. Keep
// where the user was, and across a reload too: with a few thousand files, hunting for the open one
// again is the whole morning.
const sideScrollKey = `docreview:side:${WS}`;
// Set until the first render has applied it, null afterwards.
let sideScrollPending = Number(sessionStorage.getItem(sideScrollKey)) || null;

function revealActiveFile() {
  const list = $("fileList");
  const on = list.querySelector(".file-item.on");
  if (!on) return;
  // Measured against the list's box, not offsetTop: the list is not the items' offsetParent.
  const box = list.getBoundingClientRect();
  const r = on.getBoundingClientRect();
  if (r.top >= box.top && r.bottom <= box.bottom) return;
  list.scrollTop += r.top - box.top - (box.height - r.height) / 2;
}

function renderSidebar({ reveal = false } = {}) {
  const filter = $("fileFilter").value.trim().toLowerCase();
  const list = $("fileList");
  const keepScroll = sideScrollPending ?? list.scrollTop;
  const counts = new Map();
  for (const t of S.threads) if (t.status === "open") counts.set(t.file, (counts.get(t.file) || 0) + 1);
  const all = S.files.filter((f) => f.editable);
  const files = all.filter((f) => !filter || f.path.toLowerCase().includes(filter));
  const groups = fileGroups(files);
  const kids = [];
  for (const [d, items] of groups) {
    // While filtering, show what matched; the collapsed state is for the full list.
    const open = !!filter || !S.collapsed.has(d);
    const comments = items.reduce((n, f) => n + (counts.get(f.path) || 0), 0);
    const changed = items.some((f) => S.baselines.has(f.path));
    kids.push(h("button", {
      class: "file-dir" + (open ? " open" : ""), "aria-expanded": String(open),
      title: `${open ? "Collapse" : "Expand"} ${d || "the workspace root"}`,
      onclick: () => toggleDir(d),
    },
      h("span", { class: "caret", html: ICON.caret }),
      h("span", { class: "dir-nm" }, d || S.wsName || "Files"),
      !open && changed ? h("span", { class: "chg", title: "AI changes to review" }) : null,
      comments ? h("span", { class: "badge" }, String(comments)) : null,
      h("span", { class: "n" }, String(items.length))));
    if (!open) continue;
    for (const f of items) {
      const n = counts.get(f.path);
      kids.push(h("button", { class: "file-item" + (f.path === S.file ? " on" : ""), title: f.path, onclick: () => openFile(f.path) },
        h("span", { class: "ext" }, f.ext.slice(1, 4)),
        h("span", { class: "nm" }, f.path.slice(d ? d.length + 1 : 0)),
        S.baselines.has(f.path) ? h("span", { class: "chg", title: "AI changes to review" }) : null,
        n ? h("span", { class: "badge" }, String(n)) : null));
    }
  }
  if (!files.length) kids.push(h("div", { class: "file-none" }, filter ? "No match" : "No .md / .txt / .tex files"));
  list.replaceChildren(...kids);
  const plural = (n) => `${n} file${n === 1 ? "" : "s"}`;
  $("fileCount").textContent = filter ? `${files.length} of ${plural(all.length)}` : plural(all.length);
  // Before the scrolling: the rule panel takes height off the list.
  renderStylePanel();
  list.scrollTop = keepScroll;
  // On the first render, and whenever the open file changes, make sure it is actually on screen.
  if (reveal || sideScrollPending != null) revealActiveFile();
  sideScrollPending = null;
}

// ---------- display rules ----------

const ruleWhat = (r) => (r.match.literal != null ? `"${r.match.literal}"` : `/${r.match.regex}/`);

function renderStylePanel() {
  const box = $("stylePanel");
  const mine = S.file ? S.styles.filter((r) => matchesScope(r.scope, S.file)) : [];
  box.classList.toggle("on", mine.length > 0);
  if (!mine.length) return void box.replaceChildren();
  const open = !S.stylePanelShut;
  fill(box,
    h("button", { class: "style-head" + (open ? " open" : ""), title: open ? "Hide the rules" : "Show the rules", onclick: () => {
      S.stylePanelShut = open;
      store.set("stylePanelShut", S.stylePanelShut);
      renderStylePanel();
    } },
      h("span", { class: "caret", html: ICON.caret }),
      h("span", { class: "dir-nm" }, "Display rules"),
      h("span", { class: "n" }, String(mine.length))),
    open ? h("div", { class: "style-rules" }, mine.map((r) =>
      h("label", { class: "style-rule", title: `${ruleWhat(r)} · ${r.scope.join(", ")}` },
        h("input", { type: "checkbox", checked: r.enabled !== false, onchange: (e) => toggleStyleRule(r, e.target.checked) }),
        h("span", { class: "sw", style: styleCss(r.style) || null }, "Aa"),
        h("span", { class: "rl" }, r.label)))) : null);
}

// ---------- outline ----------

const outlineBox = $("outline");
let outlineCache = { text: null, kind: null, list: [] };

function outline() {
  if (!S.file) return [];
  if (outlineCache.text === S.text && outlineCache.kind === S.kind) return outlineCache.list;
  outlineCache = { text: S.text, kind: S.kind, list: outlineOf(S.text, S.kind) };
  return outlineCache.list;
}

function toggleOutline() {
  if (outlineBox.classList.contains("on")) return closeOutline();
  const list = outline();
  if (!list.length) return toast(S.file ? "No headings in this file." : "Open a file first.");
  const here = headingAt(list, viewOffset());
  fill(outlineBox, list.map((hd) =>
    h("button", {
      class: "out-row" + (hd === here ? " on" : ""), "data-lvl": Math.min(hd.level, 6),
      onclick: () => {
        closeOutline();
        scrollToOffset(hd.start);
      },
    }, h("span", { class: "out-dash" }), h("span", { class: "out-t" }, hd.title))));
  outlineBox.classList.add("on");
  const r = $("fileName").getBoundingClientRect();
  outlineBox.style.left = Math.min(r.left, window.innerWidth - outlineBox.offsetWidth - 10) + "px";
  outlineBox.style.top = r.bottom + 8 + "px";
  outlineBox.querySelector(".out-row.on")?.scrollIntoView({ block: "center" });
}

function closeOutline() {
  outlineBox.classList.remove("on");
}

// Where the reader is now, as a source offset: the topmost thing still on screen.
function viewOffset() {
  if (S.mode === "edit") return src.selectionStart || 0;
  const sc = $("scroller");
  const top = sc.getBoundingClientRect().top + 8;
  for (const el of $("doc").querySelectorAll("[data-s]")) {
    if (el.getBoundingClientRect().bottom >= top) return Number(el.dataset.s);
  }
  return 0;
}

// Put a source offset at the top of the view, without selecting anything: this is navigation.
// The jump lands rather than glides: the scroller animates smoothly by default, which over a few
// thousand pixels is slow, and an animation that something else interrupts leaves you nowhere.
function scrollToOffset(pos) {
  const sc = $("scroller");
  if (S.mode === "pdf" || (S.mode === "changes" && modesFor().includes("edit"))) setMode(modesFor()[0]);
  if (S.mode === "read") {
    const el = [...$("doc").querySelectorAll("[data-s]")].find((e) => Number(e.dataset.s) >= pos);
    if (el) return void sc.scrollBy({ top: el.getBoundingClientRect().top - sc.getBoundingClientRect().top - 20, behavior: "instant" });
  }
  if (S.mode !== "edit") return;
  src.focus();
  src.setSelectionRange(pos, pos);
  sc.scrollBy({ top: backdropRect(pos).top - sc.getBoundingClientRect().top - 20, behavior: "instant" });
}

// ---------- display recipes ----------
//
// A recipe is the wording for a display rule plus the files it should cover. The user picks one,
// tweaks the words, ticks files or whole folders, and it goes in as an ordinary /style comment,
// so the AI handles it in the next round like anything else they wrote by hand.

const recBox = $("rec");
let rec = null;

function openRecipes() {
  if (!S.files.some((f) => f.editable)) return toast("No files to apply a rule to.");
  rec = { id: RECIPES[0].id, values: {}, text: null, picked: new Set(S.file ? [S.file] : []), open: new Set([dirOf(S.file || "")]) };
  renderRec();
  recBox.classList.add("on");
  $("recBackdrop").classList.add("on");
}

function closeRecipes() {
  rec = null;
  recBox.classList.remove("on");
  $("recBackdrop").classList.remove("on");
}

const recFiles = () => S.files.filter((f) => f.editable);
const recPrompt = () => (rec.text ?? fillPrompt(findRecipe(rec.id), rec.values, scopeGlobs(rec.picked, recFiles())));

// Only the preview changes while the user types, so the caret stays where they put it.
function syncRecPrompt() {
  const ta = recBox.querySelector(".rec-prompt");
  if (ta && rec.text == null) ta.value = recPrompt();
  const sum = recBox.querySelector(".rec-sum");
  if (sum) sum.textContent = scopeSummary();
  const add = recBox.querySelector(".rec-add");
  if (add) add.disabled = !rec.picked.size || !S.file;
}

function scopeSummary() {
  const n = rec.picked.size;
  if (!n) return "No files picked";
  const globs = scopeGlobs(rec.picked, recFiles());
  if (globs.length === 1 && globs[0] === "**") return `Every file (${n})`;
  return `${n} file${n === 1 ? "" : "s"} · ${globs.join(", ")}`;
}

function renderRec() {
  const def = findRecipe(rec.id);
  fill(recBox,
    h("div", { class: "rec-head" },
      h("h3", {}, "Display recipes"),
      h("button", { class: "icon-btn sm", title: "Close (Esc)", html: ICON.x, onclick: () => closeRecipes() })),
    h("div", { class: "rec-body" },
      h("div", { class: "rec-list" }, RECIPES.map((r) =>
        h("button", { class: "rec-item" + (r.id === rec.id ? " on" : ""), onclick: () => {
          rec.id = r.id;
          rec.values = {};
          rec.text = null;
          renderRec();
        } },
          h("b", {}, r.name),
          h("small", {}, r.blurb)))),
      h("div", { class: "rec-main" },
        def.fields?.length ? h("div", { class: "rec-fields" }, def.fields.map((f) =>
          h("label", { class: "rec-field" },
            h("span", {}, f.label),
            h("input", {
              placeholder: f.placeholder || "", value: rec.values[f.name] || "", spellcheck: "false",
              oninput: (e) => {
                rec.values[f.name] = e.target.value;
                syncRecPrompt();
              },
            })))) : null,
        h("div", { class: "rec-scope" },
          h("div", { class: "rec-scope-head" },
            h("span", { class: "rec-sum" }, scopeSummary()),
            h("button", { class: "btn small", onclick: () => pickScope("file") }, "This file"),
            h("button", { class: "btn small", onclick: () => pickScope("all") }, "All"),
            h("button", { class: "btn small", onclick: () => pickScope("none") }, "None")),
          h("div", { class: "rec-tree" }, recTree())),
        h("textarea", {
          class: "rec-prompt", spellcheck: "true", rows: "5",
          oninput: (e) => {
            rec.text = e.target.value;
            syncRecPrompt();
          },
        })),
    ),
    h("div", { class: "rec-foot" },
      h("span", {}, S.file ? `Goes in as a comment on ${S.file}` : "Open a file first"),
      h("button", { class: "btn", onclick: () => addRecipe(false) }, "Add comment"),
      h("button", { class: "btn primary rec-add", onclick: () => addRecipe(true) }, "Add and send")));
  recBox.querySelector(".rec-prompt").value = recPrompt();
  syncRecPrompt();
  requestAnimationFrame(() => recBox.querySelector(".rec-fields input")?.focus());
}

function pickScope(what) {
  if (what === "all") rec.picked = new Set(recFiles().map((f) => f.path));
  else if (what === "none") rec.picked = new Set();
  else rec.picked = new Set(S.file ? [S.file] : []);
  renderRecTree();
}

function renderRecTree() {
  const box = recBox.querySelector(".rec-tree");
  if (box) fill(box, recTree());
  syncRecPrompt();
}

// The sidebar's folders again, but as a picker: the folder's own box takes the whole category.
function recTree() {
  const out = [];
  for (const [d, items] of fileGroups(recFiles())) {
    const on = items.filter((f) => rec.picked.has(f.path)).length;
    const open = rec.open.has(d);
    const box = h("input", {
      type: "checkbox", checked: on === items.length && on > 0,
      onchange: (e) => {
        for (const f of items) e.target.checked ? rec.picked.add(f.path) : rec.picked.delete(f.path);
        renderRecTree();
      },
    });
    // Half-picked folders read as half-picked; only the property shows it, never an attribute.
    box.indeterminate = on > 0 && on < items.length;
    out.push(h("div", { class: "rec-dir" }, box,
      h("button", { class: "rec-dir-name" + (open ? " open" : ""), onclick: () => {
        rec.open.has(d) ? rec.open.delete(d) : rec.open.add(d);
        renderRecTree();
      } },
        h("span", { class: "caret", html: ICON.caret }),
        h("span", { class: "dir-nm" }, d || S.wsName || "Files"),
        h("span", { class: "n" }, on ? `${on}/${items.length}` : String(items.length)))));
    if (!open) continue;
    for (const f of items) {
      out.push(h("label", { class: "rec-file", title: f.path },
        h("input", {
          type: "checkbox", checked: rec.picked.has(f.path),
          onchange: (e) => {
            e.target.checked ? rec.picked.add(f.path) : rec.picked.delete(f.path);
            renderRecTree();
          },
        }),
        h("span", { class: "nm" }, f.path.slice(d ? d.length + 1 : 0))));
    }
  }
  return out;
}

async function addRecipe(andSend) {
  if (!S.file) return toast("Open a file first: the comment is anchored in one.");
  if (!rec.picked.size) return toast("Pick at least one file for the rule to apply to.");
  const text = recPrompt().trim();
  if (!text) return;
  try {
    if (S.dirty) await save();
    const t = await api("POST", "/api/threads", { file: S.file, anchor: makeAnchor(S.text, 0, 0), text });
    S.threads.push(t);
    closeRecipes();
    if (andSend) await send();
    else toast("Added. Press Send to AI when you are ready.");
    scheduleRefresh();
  } catch (err) {
    toast(err.message);
  }
}

// ---------- hover notes ----------

const noteTip = $("noteTip");
let tipFor = null;

function showNoteTip(el) {
  if (tipFor === el) return;
  tipFor = el;
  noteTip.textContent = el.dataset.note;
  noteTip.classList.add("on");
  const r = el.getBoundingClientRect();
  const w = noteTip.offsetWidth;
  const h = noteTip.offsetHeight;
  noteTip.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + "px";
  noteTip.style.top = (r.top - h - 8 < 8 ? r.bottom + 8 : r.top - h - 8) + "px";
}

function hideNoteTip() {
  tipFor = null;
  noteTip.classList.remove("on");
}

async function toggleStyleRule(rule, enabled) {
  rule.enabled = enabled;
  renderView();
  renderStylePanel();
  try {
    await api("PATCH", "/api/styles/" + rule.id, { enabled });
  } catch (err) {
    rule.enabled = !enabled;
    renderView();
    renderStylePanel();
    toast(err.message);
  }
}

// ---------- files & modes ----------

async function openFile(path) {
  if (S.file) saveView();
  if (S.dirty) await save();
  closeModal(true);
  hideChip();
  S.draft = null;
  S.active = null;
  S.undo = [];
  S.file = path;
  S.kind = kindOf(path);
  // Never leave the open file hidden inside a collapsed folder.
  if (S.collapsed.delete(dirOf(path))) store.set("collapsedDirs:" + WS, [...S.collapsed]);
  $("pdfPages").replaceChildren();
  S.pdfBoxes = new Map();
  store.set("lastFile:" + WS, path);
  const url = new URL(location.href);
  url.searchParams.set("file", path);
  history.replaceState(null, "", url);
  document.body.classList.remove("no-file");
  $("fileName").textContent = path;
  await reloadFile();
  const modes = modesFor();
  const preferred = store.get("mode:" + S.kind, modes[0]);
  setMode(modes.includes(preferred) && preferred !== "changes" ? preferred : modes[0], true);
  renderSidebar({ reveal: true });
  restoreView();
}

async function reloadFile() {
  if (!S.file) return;
  try {
    const f = await api("GET", "/api/file?path=" + encodeURIComponent(S.file));
    const prev = S.text;
    S.text = f.text;
    S.hash = f.hash;
    S.baseline = f.baseline;
    S.dirty = false;
    if (S.draft && prev !== f.text) S.draft = mapRange(offsetMapper(prev, f.text), S.draft.start, S.draft.end);
    resolveAll();
    if (S.mode === "changes" && !hasChanges()) setMode(modesFor()[0]);
    else renderModes(), renderView();
    if (S.mode === "pdf") schedulePdf();
  } catch (err) {
    toast(err.message);
  }
}

function modesFor() {
  const m = S.kind === "tex" ? ["edit", ...(S.latex ? ["pdf"] : [])] : ["read", "edit"];
  if (hasChanges()) m.push("changes");
  return m;
}

const MODE_LABEL = { read: "Read", edit: "Edit", pdf: "PDF", changes: "Changes" };

function renderModes() {
  const modes = modesFor();
  $("modes").replaceChildren(...modes.map((m) =>
    h("button", { class: m === S.mode ? "on" : "", role: "tab", onclick: () => setMode(m) },
      m === "edit" && S.kind === "tex" ? "Source" : MODE_LABEL[m], m === "changes" ? h("span", { class: "dot" }) : null)));
}

function setMode(mode, initial = false) {
  if (S.dirty && mode !== "edit") save();
  S.mode = mode;
  if (!initial || mode !== "changes") store.set("mode:" + S.kind, mode);
  document.body.classList.remove("mode-read", "mode-edit", "mode-changes", "mode-pdf");
  document.body.classList.add("mode-" + mode);
  hideChip();
  renderModes();
  renderView();
  if (mode === "pdf") compilePdf();
  if (mode === "edit") updateLock();
}

function renderView() {
  if (!S.file) return;
  if (S.mode === "read") renderDoc();
  else if (S.mode === "edit") renderSource();
  else if (S.mode === "changes") renderChanges();
  if (S.mode === "read" || S.mode === "edit" || S.mode === "pdf") renderCards();
  if (S.mode === "pdf") paintPdf();
}

function viewEl() {
  return S.mode === "edit" ? $("backdrop") : S.mode === "pdf" ? $("pdfPages") : $("doc");
}

// ---------- reading view ----------

function renderDoc() {
  const tree = S.kind === "md" ? parseMarkdown(S.text) : parsePlain(S.text);
  const dom = renderTree(tree, rangesForRender(), (p) => rawUrl(relToFile(p)), marksForRender());
  const doc = $("doc");
  // Re-rendering replaces the text nodes; carry a live selection over to the new ones.
  const sel = window.getSelection();
  const keep = sel.rangeCount && !sel.isCollapsed && doc.contains(sel.anchorNode) ? selectionToSource(doc) : null;
  doc.classList.toggle("plain", S.kind !== "md");
  doc.replaceChildren(...dom.childNodes);
  if (keep) selectSource(keep.start, keep.end);
  for (const img of doc.querySelectorAll("img")) img.addEventListener("load", () => layoutCards(), { once: true });
  markActive();
}

// ---------- source editor ----------

const src = $("src");

function renderSource() {
  if (src.value !== S.text) {
    const { selectionStart: a, selectionEnd: b } = src;
    src.value = S.text;
    if (document.activeElement === src) src.setSelectionRange(Math.min(a, S.text.length), Math.min(b, S.text.length));
  }
  paintBackdrop();
}

function paintBackdrop() {
  $("backdrop").innerHTML = buildBackdrop(S.text, rangesForRender(), S.kind === "txt" ? "txt" : S.kind, marksForRender());
  // Shrinking to "auto" to measure would clamp the page scroll; pin the wrapper height meanwhile.
  const wrap = $("srcWrap");
  const sc = $("scroller");
  const top = sc.scrollTop;
  wrap.style.minHeight = wrap.offsetHeight + "px";
  src.style.height = "auto";
  src.style.height = src.scrollHeight + "px";
  wrap.style.minHeight = "";
  sc.scrollTop = top;
  markActive();
}

function updateLock() {
  src.readOnly = editLocked();
}

// Caret rectangle for a source offset, measured on the backdrop (same layout as the textarea).
// Where an offset sits on screen in the source overlay. A collapsed range often has no client
// rect at all, and the old fallback then handed back the whole backdrop, which reads as "the top
// of the file" and sends every jump there. One real character always has a rect, so measure that.
function backdropRect(offset) {
  const bd = $("backdrop");
  const walker = document.createTreeWalker(bd, NodeFilter.SHOW_TEXT);
  let n;
  let pos = 0;
  let last = null;
  while ((n = walker.nextNode())) {
    const len = n.nodeValue.length;
    if (!len) continue;
    if (pos + len > offset) {
      const at = Math.max(0, offset - pos);
      const r = document.createRange();
      r.setStart(n, at);
      r.setEnd(n, at + 1);
      const rect = r.getClientRects()[0] || r.getBoundingClientRect();
      if (rect.height) return rect;
    }
    last = n;
    pos += len;
  }
  // Past the end of the text: the last character is as close as we get.
  if (last) {
    const r = document.createRange();
    r.setStart(last, last.nodeValue.length - 1);
    r.setEnd(last, last.nodeValue.length);
    const rect = r.getClientRects()[0] || r.getBoundingClientRect();
    if (rect.height) return rect;
  }
  return bd.getBoundingClientRect();
}

let lastInputText = null;
src.addEventListener("beforeinput", () => (lastInputText = S.text));
src.addEventListener("input", () => {
  const prev = lastInputText ?? S.text;
  const next = src.value;
  if (prev !== next) {
    const map = offsetMapper(prev, next);
    for (const [id, r] of S.live) S.live.set(id, mapRange(map, r.start, r.end));
    if (S.draft) S.draft = mapRange(map, S.draft.start, S.draft.end);
  }
  S.text = next;
  lastInputText = null;
  S.dirty = true;
  setSaveState("Editing…");
  paintBackdrop();
  layoutCards();
  scheduleSave();
});

function applyEdit(edit) {
  if (!edit) return;
  if (S.mode === "edit") {
    src.focus({ preventScroll: true });
    src.setSelectionRange(edit.from, edit.to);
    // insertText keeps the browser's own undo stack (⌘Z) working.
    if (!document.execCommand("insertText", false, edit.insert)) {
      src.setRangeText(edit.insert, edit.from, edit.to, "end");
      src.dispatchEvent(new Event("input"));
    }
    src.setSelectionRange(edit.selStart, edit.selEnd);
    return;
  }
  // Reading view: apply to the text and save right away; ⌘Z pops our own stack.
  const next = S.text.slice(0, edit.from) + edit.insert + S.text.slice(edit.to);
  S.undo.push(S.text);
  setText(next);
  save();
}

function setText(next) {
  const map = offsetMapper(S.text, next);
  for (const [id, r] of S.live) S.live.set(id, mapRange(map, r.start, r.end));
  S.text = next;
  S.dirty = true;
  renderView();
}

src.addEventListener("keydown", (e) => {
  if (acKeydown(e)) return;
  const cmd = shortcut(e);
  if (!cmd) {
    if (src.readOnly && !e.metaKey && !e.ctrlKey && e.key.length === 1) lockedHint();
    return;
  }
  if (cmd === "save") return e.preventDefault(), save();
  if (cmd === "send") return e.preventDefault(), send();
  if (cmd === "comment") return e.preventDefault(), startDraft(src.selectionStart, src.selectionEnd);
  if (src.readOnly) return e.preventDefault(), lockedHint();
  const edit = command(cmd, S.text, src.selectionStart, src.selectionEnd, S.kind);
  if (edit) {
    e.preventDefault();
    applyEdit(edit);
  }
});

let hintShown = 0;
function lockedHint() {
  if (Date.now() - hintShown < 4000) return;
  hintShown = Date.now();
  if (S.aiWorking) toast("The AI is editing. You can comment meanwhile; typing unlocks when it finishes.");
  else if (hasChanges()) toast("Accept or revert the AI's changes first.", { action: "Review", onAction: () => setMode("changes") });
}

function scheduleSave() {
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(save, 700);
}

let saving = null;
async function save() {
  clearTimeout(S.saveTimer);
  if (!S.dirty || !S.file) return;
  if (saving) await saving;
  const text = S.text;
  const file = S.file;
  saving = (async () => {
    try {
      setSaveState("Saving…");
      const r = await api("PUT", "/api/file", { path: file, text, baseHash: S.hash });
      if (file !== S.file) return;
      S.hash = r.hash;
      if (S.text === text) {
        S.dirty = false;
        setSaveState("Saved");
      }
    } catch (err) {
      if (err.status === 409 && err.data?.current) {
        S.text = err.data.current.text;
        S.hash = err.data.current.hash;
        S.dirty = false;
        resolveAll();
        renderView();
        toast("The file changed on disk; showing the latest version.");
      } else {
        setSaveState("Not saved");
        toast("Couldn't save: " + err.message);
      }
    } finally {
      saving = null;
    }
  })();
  return saving;
}

let saveFade = null;
function setSaveState(text) {
  const el = $("saveState");
  el.textContent = text;
  el.style.opacity = 1;
  clearTimeout(saveFade);
  if (text === "Saved") saveFade = setTimeout(() => (el.style.opacity = 0), 1600);
}

// ---------- view state across reloads ----------
// A reload (or coming back to a file in the same tab) puts you back where you were: scroll,
// selection, active comment, open popup, unsent comment drafts. Kept in sessionStorage, so it is
// per tab and per file, and a fresh tab starts clean.

const viewKey = () => `docreview:view:${WS}:${S.file}`;

function saveView() {
  if (!S.file) return;
  const sel = S.mode === "edit"
    ? { start: src.selectionStart, end: src.selectionEnd, focus: document.activeElement === src }
    : S.mode === "read" ? selectionToSource($("doc")) : null;
  const v = {
    mode: S.mode,
    scroll: $("scroller").scrollTop,
    sel: sel && { start: sel.start, end: sel.end, focus: !!sel.focus },
    active: S.active,
    modal: modalId,
    draft: S.draft && { ...S.draft, text: document.querySelector(".card.draft textarea")?.value || "" },
    replies: [...S.replyDrafts].filter(([, t]) => t),
    // Fallback for typing the keepalive save below could not deliver (body over 64 KB, server busy).
    unsaved: S.dirty ? { text: S.text, hash: S.hash } : null,
  };
  try {
    sessionStorage.setItem(viewKey(), JSON.stringify(v));
  } catch {}
}

function restoreView() {
  let v = null;
  try {
    v = JSON.parse(sessionStorage.getItem(viewKey()));
  } catch {}
  const sc = $("scroller");
  if (!v) return void (sc.scrollTop = 0);
  for (const [k, t] of v.replies || []) S.replyDrafts.set(k, t);
  if (v.unsaved && v.unsaved.hash === S.hash && v.unsaved.text !== S.text && !editLocked()) {
    S.text = v.unsaved.text;
    S.dirty = true;
    resolveAll();
    save();
  }
  if (v.mode && v.mode !== S.mode && modesFor().includes(v.mode)) setMode(v.mode, true);
  const len = S.text.length;
  if (v.draft && v.draft.end <= len) {
    S.draft = { start: v.draft.start, end: v.draft.end };
    S.active = "draft";
  } else if (v.active && S.threads.some((t) => t.id === v.active)) S.active = v.active;
  renderView();
  const ta = document.querySelector(".card.draft textarea");
  if (ta && v.draft?.text) (ta.value = v.draft.text), ta.dispatchEvent(new Event("input"));
  // The scroller scrolls smoothly; a restore must jump.
  const scroll = () => sc.scrollTo({ top: v.scroll || 0, behavior: "instant" });
  // The PDF renders later; it applies this once its pages exist.
  if (S.mode === "pdf") S.pdfScroll = v.scroll || 0;
  const s = v.sel;
  const select = () => {
    if (!s || s.end > len || (s.end <= s.start && !s.focus)) return;
    if (S.mode === "edit") {
      src.focus({ preventScroll: true });
      src.setSelectionRange(s.start, s.end);
    } else if (S.mode === "read" && s.end > s.start) {
      const r = selectSource(s.start, s.end);
      if (r) showChip({ start: s.start, end: s.end }, r.getBoundingClientRect().top);
    }
  };
  scroll();
  select();
  // Math renders once KaTeX arrives, which rebuilds the page and changes heights; restore again after.
  if (!window.katex) window.addEventListener("load", () => requestAnimationFrame(() => (scroll(), select())), { once: true });
  if (ta && !v.modal) ta.focus({ preventScroll: true });
  if (v.modal && S.threads.some((t) => t.id === v.modal)) openModal(v.modal);
}

// Leaving or reloading: store the view and push unsaved typing to disk. keepalive lets the request
// finish after the page is gone.
window.addEventListener("pagehide", () => {
  saveView();
  if (S.dirty && S.file) {
    fetch(`/api/file?ws=${WS}`, {
      method: "PUT",
      keepalive: true,
      headers: { "content-type": "application/json", "x-token": TOKEN },
      body: JSON.stringify({ path: S.file, text: S.text, baseHash: S.hash }),
    }).catch(() => {});
  }
});

// ---------- selection, chip, drafts ----------

const chip = $("addChip");

function showChip(sel, y) {
  const margin = $("margin").getBoundingClientRect();
  const top = Math.max(70, Math.min(window.innerHeight - 60, y - 6));
  // Sits at the head of the margin, where the new comment card will open.
  chip.style.left = margin.left + 8 + "px";
  chip.style.top = top + "px";
  chip.classList.add("on");
  S.chip = sel;
}

function hideChip() {
  chip.classList.remove("on");
  S.chip = null;
}

chip.addEventListener("mousedown", (e) => e.preventDefault());
chip.addEventListener("click", () => {
  if (!S.chip) return;
  const { start, end, pdf } = S.chip;
  hideChip();
  startDraft(start, end, pdf);
});

function readSelection() {
  if (S.mode === "edit") {
    if (document.activeElement !== src) return null;
    const { selectionStart: a, selectionEnd: b } = src;
    return { start: a, end: b, collapsed: a === b, rect: backdropRect(a) };
  }
  if (S.mode === "read") return selectionToSource($("doc"));
  return null;
}

let mouseDownAt = null;
document.addEventListener("mousedown", (e) => {
  mouseDownAt = { x: e.clientX, y: e.clientY };
});

document.addEventListener("mouseup", (e) => {
  if (S.file && S.mode === "pdf") return void pdfMouseUp(e);
  if (!S.file || (S.mode !== "read" && S.mode !== "edit")) return;
  if (e.target.closest(".card, .add-chip, .modal, .top, .sidebar, .autocomplete")) return;
  setTimeout(() => {
    const sel = readSelection();
    if (sel && !sel.collapsed && sel.end > sel.start) return showChip(sel, sel.rect.top);
    // A plain click on the page (not on a highlight) offers a point comment there.
    const moved = mouseDownAt && Math.hypot(e.clientX - mouseDownAt.x, e.clientY - mouseDownAt.y) > 4;
    if (S.mode === "read" && !moved && e.target.closest(".page") && !e.target.closest(".hl, a, .pin, .margin")) {
      const pos = pointAt(e.clientX, e.clientY);
      if (pos != null) return showChip({ start: pos, end: pos }, e.clientY - 12);
    }
    hideChip();
  }, 0);
});

document.addEventListener("selectionchange", () => {
  if (S.mode !== "edit" || document.activeElement !== src) return;
  if (src.selectionStart === src.selectionEnd && S.chip) hideChip();
});

// Offset for a click: inside text use the caret position, in empty space the nearest block edge.
function pointAt(x, y) {
  const doc = $("doc");
  const rect = doc.getBoundingClientRect();
  const inside = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  if (inside) {
    const c = caretAt(x, y);
    if (c && doc.contains(c.node)) {
      const p = pointToSource(doc, c.node, c.offset);
      if (p != null) return p;
    }
  }
  const blocks = [...doc.children].filter((b) => b.dataset.s != null);
  if (!blocks.length) return 0;
  let best = blocks[0];
  for (const b of blocks) if (b.getBoundingClientRect().top <= y) best = b;
  const br = best.getBoundingClientRect();
  return Number(y > br.top + br.height / 2 ? best.dataset.e : best.dataset.s);
}

async function startDraft(start, end, pdf = null) {
  if (!S.file) return;
  if (S.mode === "edit" && S.dirty) await save();
  window.getSelection()?.removeAllRanges?.();
  S.draft = { start, end, pdf };
  S.active = "draft";
  renderView();
  requestAnimationFrame(() => document.querySelector('.card.draft textarea')?.focus());
}

function cancelDraft() {
  if (!S.draft) return;
  S.draft = null;
  if (S.active === "draft") S.active = null;
  renderView();
}

async function submitDraft(text) {
  if (!S.draft || !text.trim()) return;
  const anchor = makeAnchor(S.text, S.draft.start, S.draft.end);
  try {
    if (S.dirty) await save();
    const t = await api("POST", "/api/threads", { file: S.file, anchor, text, pdf: S.draft.pdf || undefined });
    S.threads.push(t);
    S.live.set(t.id, { start: S.draft.start, end: S.draft.end });
    S.draft = null;
    S.active = t.id;
    renderView();
    scheduleRefresh();
  } catch (err) {
    toast(err.message);
  }
}

// ---------- margin cards ----------

const rel = (iso) => {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 45) return "now";
  if (s < 3600) return Math.round(s / 60) + "m";
  if (s < 86400) return Math.round(s / 3600) + "h";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

function richText(text) {
  const files = new Set(S.files.map((f) => f.path));
  let html = esc(text);
  const cmd = parseCommand(text);
  if (cmd) {
    html = html.replace(/^(\s*)\/[\w-]+/, (m, pre) =>
      `${pre}<span class="chip-cmd act-${cmd.def.action}" title="${esc(cmd.def.summary + " · " + ACTION_LABEL[cmd.def.action])}">/${cmd.name}</span>`);
  }
  html = html.replace(/(^|[\s(])(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
  html = html.replace(/(^|[\s(])@([\w./-]*[\w/])/g, (m, pre, p) =>
    `${pre}<span class="chip-ref" data-file="${files.has(p) ? p : ""}" title="${files.has(p) ? "Open " + p : p}">@${p}</span>`);
  html = html.replace(/(^|[\s(])#([\w-]+)/g, (m, pre, t) =>
    `${pre}<span class="chip-ref chip-tag" title="${esc(S.tags[t]?.description || "Tag")}">#${t}</span>`);
  return html;
}

function avatar(author, small) {
  return author === "ai"
    ? h("span", { class: "avatar ai" + (small ? " sm" : ""), html: ICON.spark })
    : h("span", { class: "avatar" + (small ? " sm" : "") }, "Y");
}

const who = (m) => (m.author === "ai" ? "AI" : "You");

function msgMeta(t, m) {
  if (m.author !== "user") return null;
  const label = { pending: "Not sent", submitted: "Sent", delivered: "Read by AI" }[m.state] || "";
  return h("div", { class: "msg-meta" },
    h("span", { class: "state " + (m.state || "") }, label),
    m.state === "pending" ? h("button", { onclick: (e) => (e.stopPropagation(), editMessage(t, m)) }, "Edit") : null,
    m.state === "pending" ? h("button", { onclick: (e) => (e.stopPropagation(), deleteMessage(t, m)) }, "Delete") : null);
}

function messageEl(t, m, i) {
  const first = i === 0;
  const text = h("div", { class: "msg-text", html: richText(m.text) });
  return h("div", { class: "msg" + (first ? "" : " reply") + (m.author === "ai" ? " ai" : "") },
    first ? null : h("div", { class: "msg-who" }, avatar(m.author, true), who(m), h("time", {}, rel(m.at))),
    m.kind === "question" ? h("span", { class: "tagq" }, "Question") : null,
    text,
    msgMeta(t, m));
}

function composer({ placeholder, value = "", onSubmit, onCancel, submitLabel = "Comment", key }) {
  const ta = h("textarea", { rows: 1, placeholder });
  ta.value = value;
  const fit = () => {
    ta.style.height = "auto";
    ta.style.height = Math.min(260, ta.scrollHeight + 2) + "px";
    if (key) S.replyDrafts.set(key, ta.value);
    btn.disabled = !ta.value.trim();
  };
  const go = () => {
    const v = ta.value;
    if (!v.trim()) return;
    if (key) S.replyDrafts.delete(key);
    ta.value = "";
    fit();
    onSubmit(v);
  };
  const btn = h("button", { class: "btn primary small", onclick: (e) => (e.stopPropagation(), go()) }, submitLabel);
  ta.addEventListener("input", () => (fit(), acInput(ta)));
  ta.addEventListener("keydown", (e) => {
    if (acKeydown(e)) return;
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.shiftKey) return e.preventDefault(), go();
    if (e.key === "Escape") return e.preventDefault(), e.stopPropagation(), onCancel?.();
  });
  ta.addEventListener("blur", () => setTimeout(acClose, 120));
  queueMicrotask(fit);
  return h("div", { class: "composer", onclick: (e) => e.stopPropagation() }, ta,
    h("div", { class: "composer-actions" },
      h("span", { class: "composer-hint" }, "/ command · @ file · # tag · ⌘↵"),
      onCancel ? h("button", { class: "btn ghost small", onclick: (e) => (e.stopPropagation(), onCancel()) }, "Cancel") : null,
      btn));
}

function cardEl(t) {
  const kind = threadKind(t);
  const first = t.messages[0];
  const resolved = t.status === "resolved";
  const actions = h("div", { class: "card-actions" },
    resolved
      ? h("button", { class: "icon-btn sm", title: "Reopen", html: ICON.reopen, onclick: (e) => (e.stopPropagation(), setThreadStatus(t, "open")) })
      : h("button", { class: "icon-btn sm", title: "Resolve", html: ICON.check, onclick: (e) => (e.stopPropagation(), setThreadStatus(t, "resolved")) }),
    h("button", { class: "icon-btn sm", title: "Open as conversation", html: ICON.expand, onclick: (e) => (e.stopPropagation(), openModal(t.id)) }),
    h("button", { class: "icon-btn sm", title: "Delete thread", html: ICON.trash, onclick: (e) => (e.stopPropagation(), deleteThread(t)) }));
  const card = h("div", {
    class: `card k-${kind}` + (resolved ? " resolved" : "") + (kind === "question" ? " question" : "") + (S.active === t.id ? " on" : ""),
    "data-id": t.id,
    onclick: () => setActive(t.id, true),
  },
    h("div", { class: "card-head" }, avatar(first.author), h("div", { class: "who" }, h("b", {}, who(first)), h("time", {}, rel(first.at))), actions),
    t.anchor.quote && resolved ? h("div", { class: "card-quote" }, t.anchor.quote) : null,
    h("div", { class: "msgs" }, t.messages.map((m, i) => messageEl(t, m, i))),
    resolved ? h("div", { class: "resolved-note", html: ICON.check + `<span>Resolved${t.resolvedBy === "ai" ? " by AI" : ""}</span>` }) : null,
    composer({
      key: t.id,
      placeholder: kind === "question" ? "Answer the AI…" : "Reply…",
      value: S.replyDrafts.get(t.id) || "",
      submitLabel: "Reply",
      onSubmit: (v) => reply(t, v),
      onCancel: () => setActive(null),
    }));
  return card;
}

function draftCard() {
  return h("div", { class: "card draft on", "data-id": "draft" },
    h("div", { class: "card-head" }, avatar("user"), h("div", { class: "who" }, h("b", {}, "You"), h("time", {}, S.draft.start === S.draft.end ? "comment here" : "new comment"))),
    composer({ placeholder: "Comment, or ask for a change…", onSubmit: submitDraft, onCancel: cancelDraft }));
}

function renderCards() {
  const margin = $("margin");
  const focused = document.activeElement?.closest?.(".card")?.dataset.id;
  const caret = document.activeElement?.tagName === "TEXTAREA" && margin.contains(document.activeElement) ? document.activeElement.selectionStart : null;
  const draftText = margin.querySelector(".card.draft textarea")?.value;
  const threads = visibleThreads();
  const placed = [];
  const detached = [];
  for (const t of threads) (S.live.has(t.id) ? placed : detached).push(t);
  const kids = [];
  if (detached.length) {
    kids.push(h("div", { class: "detached" }, h("div", { class: "detached-title" }, "Text no longer found"), detached.map(cardEl)));
  }
  kids.push(...placed.map(cardEl));
  if (S.draft) kids.push(draftCard());
  // Rebuilt cards start where their previous element was, so a refresh never makes them jump.
  const prev = new Map([...margin.querySelectorAll(":scope > .card")].map((c) => [c.dataset.id, c.style.transform]));
  for (const k of kids) {
    if (k.classList?.contains("card") && prev.has(k.dataset.id)) {
      k.style.transform = prev.get(k.dataset.id);
      k.dataset.placed = "1";
      k.style.animation = "none";
    }
  }
  margin.replaceChildren(...kids);
  if (draftText) {
    const ta = margin.querySelector(".card.draft textarea");
    if (ta) ta.value = draftText;
  }
  if (focused) {
    const ta = margin.querySelector(`.card[data-id="${focused}"] textarea`);
    if (ta) {
      ta.focus();
      if (caret != null) ta.setSelectionRange(caret, caret);
    }
  }
  layoutCards();
}

function anchorEl(id) {
  const view = viewEl();
  return view.querySelector(`.pin[data-id="${id}"]`) || view.querySelector(`[data-ids~="${id}"]`);
}

function layoutCards() {
  const margin = $("margin");
  const mtop = margin.getBoundingClientRect().top;
  const det = margin.querySelector(".detached");
  const floor = det ? det.offsetHeight + 12 : 0;
  const cards = [...margin.querySelectorAll(":scope > .card")].map((c) => {
    const a = anchorEl(c.dataset.id);
    return { c, want: a ? a.getBoundingClientRect().top - mtop - 10 : 0, h: c.offsetHeight };
  });
  cards.sort((x, y) => x.want - y.want);
  const gap = 10;
  const ai = cards.findIndex((x) => x.c.dataset.id === S.active);
  const pos = new Array(cards.length);
  // The active card sits right at its text; the others make room above and below (Google Docs style).
  if (ai >= 0) {
    pos[ai] = Math.max(floor, cards[ai].want);
    for (let i = ai + 1; i < cards.length; i++) pos[i] = Math.max(cards[i].want, pos[i - 1] + cards[i - 1].h + gap);
    for (let i = ai - 1; i >= 0; i--) pos[i] = Math.min(cards[i].want, pos[i + 1] - cards[i].h - gap);
    if (pos[0] < floor) {
      pos[0] = floor;
      for (let i = 1; i < cards.length; i++) pos[i] = Math.max(pos[i], pos[i - 1] + cards[i - 1].h + gap);
    }
  } else {
    for (let i = 0; i < cards.length; i++) pos[i] = Math.max(cards[i].want, i ? pos[i - 1] + cards[i - 1].h + gap : floor);
  }
  let bottom = floor;
  cards.forEach((x, i) => {
    if (!x.c.dataset.placed) {
      // First placement: no slide from the top of the margin.
      x.c.style.transition = "none";
      x.c.style.transform = `translateY(${pos[i]}px)`;
      x.c.offsetHeight;
      x.c.style.transition = "";
      x.c.dataset.placed = "1";
    }
    x.c.style.transform = `translateY(${pos[i]}px)`;
    bottom = Math.max(bottom, pos[i] + x.h);
  });
  margin.style.minHeight = bottom + 40 + "px";
}

function markActive() {
  const view = viewEl();
  for (const el of view.querySelectorAll(".hl.on, .pin.on")) el.classList.remove("on");
  if (!S.active) return;
  for (const el of view.querySelectorAll(`[data-ids~="${S.active}"], .pin[data-id="${S.active}"]`)) el.classList.add("on");
}

function setActive(id, fromCard = false) {
  if (S.active === id) return;
  if (S.active === "draft" && id !== "draft") {
    const t = document.querySelector(".card.draft textarea");
    if (!t?.value.trim()) S.draft = null;
  }
  const hadHidden = S.active && !S.showResolved;
  S.active = id;
  if (hadHidden || (S.draft === null && document.querySelector(".card.draft"))) {
    renderView();
  } else {
    for (const c of document.querySelectorAll("#margin .card")) c.classList.toggle("on", c.dataset.id === id);
    markActive();
    layoutCards();
  }
  if (fromCard && id) {
    const a = anchorEl(id);
    const sc = $("scroller").getBoundingClientRect();
    if (a) {
      const r = a.getBoundingClientRect();
      if (r.top < sc.top + 40 || r.bottom > sc.bottom - 40) $("scroller").scrollBy({ top: r.top - sc.top - 160, behavior: "smooth" });
    }
    requestAnimationFrame(() => document.querySelector(`.card[data-id="${id}"] .composer textarea`)?.focus({ preventScroll: true }));
  }
}

// Clicking a highlight opens its thread.
document.addEventListener("click", (e) => {
  const hl = e.target.closest("#doc .hl, #doc .pin");
  if (hl && S.mode === "read") {
    const ids = (hl.dataset.ids || hl.dataset.id || "").split(" ").filter(Boolean);
    if (ids.length) {
      const next = ids[(ids.indexOf(S.active) + 1) % ids.length];
      setActive(next);
      return;
    }
  }
  if (e.target.closest(".chip-ref[data-file]")) {
    const f = e.target.closest(".chip-ref").dataset.file;
    if (f && S.files.find((x) => x.path === f && x.editable)) openFile(f);
    return;
  }
  if (!e.target.closest(".card, .modal, .add-chip, .autocomplete, .toast, .top") && S.active && S.active !== "draft") {
    if (!window.getSelection()?.toString()) setActive(null);
  }
});

// Clicking text in the editor that carries a comment selects that comment too.
src.addEventListener("click", () => {
  if (src.selectionStart !== src.selectionEnd) return;
  const p = src.selectionStart;
  for (const t of visibleThreads()) {
    const r = S.live.get(t.id);
    if (r && p >= r.start && p <= r.end && (r.end > r.start || p === r.start)) return setActive(t.id);
  }
});

async function reply(t, text) {
  try {
    await api("POST", `/api/threads/${t.id}/messages`, { text });
    scheduleRefresh();
  } catch (err) {
    toast(err.message);
  }
}

async function setThreadStatus(t, status) {
  try {
    await api("PATCH", `/api/threads/${t.id}`, { status });
    if (status === "resolved" && !S.showResolved && S.active === t.id) S.active = null;
    scheduleRefresh();
  } catch (err) {
    toast(err.message);
  }
}

async function deleteThread(t) {
  const card = document.querySelector(`.card[data-id="${t.id}"]`);
  card?.classList.add("leaving");
  try {
    await api("DELETE", `/api/threads/${t.id}`);
    if (S.active === t.id) S.active = null;
    S.threads = S.threads.filter((x) => x.id !== t.id);
    setTimeout(() => renderView(), 180);
    toast("Comment deleted");
  } catch (err) {
    card?.classList.remove("leaving");
    toast(err.message);
  }
}

async function editMessage(t, m) {
  const card = document.querySelector(`.card[data-id="${t.id}"]`) || document.querySelector(".modal");
  const msgEl = [...(card?.querySelectorAll(".msg, .bubble") || [])][t.messages.indexOf(m)];
  if (!msgEl) return;
  const c = composer({
    placeholder: "Edit…",
    value: m.text,
    submitLabel: "Save",
    onSubmit: async (v) => {
      await api("PATCH", `/api/threads/${t.id}/messages/${m.id}`, { text: v }).catch((err) => toast(err.message));
      scheduleRefresh();
    },
    onCancel: () => scheduleRefresh(),
  });
  msgEl.replaceChildren(c);
  c.querySelector("textarea").focus();
}

async function deleteMessage(t, m) {
  await api("DELETE", `/api/threads/${t.id}/messages/${m.id}`).catch((err) => toast(err.message));
  scheduleRefresh();
}

// ---------- conversation popup ----------

const modal = $("modal");
let modalId = null;

function openModal(id) {
  const t = S.threads.find((x) => x.id === id);
  if (!t) return;
  const from = document.querySelector(`.card[data-id="${id}"]`)?.getBoundingClientRect();
  modalId = id;
  fillModal(t);
  modal.classList.add("on");
  $("modalBackdrop").classList.add("on");
  if (from) {
    const to = modal.getBoundingClientRect();
    modal.animate([
      { transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})`, opacity: 0.6 },
      { transform: "none", opacity: 1 },
    ], { duration: 320, easing: "cubic-bezier(.2,.8,.2,1)" });
  }
  requestAnimationFrame(() => modal.querySelector("textarea")?.focus());
}

function fillModal(t) {
  const hadFocus = modal.contains(document.activeElement);
  const r = S.live.get(t.id);
  let ctx = null;
  if (r) {
    const a = Math.max(0, r.start - 220);
    const b = Math.min(S.text.length, r.end + 220);
    ctx = h("div", { class: "modal-ctx", html: (a ? "…" : "") + esc(S.text.slice(a, r.start)) + (r.end > r.start ? `<mark>${esc(S.text.slice(r.start, r.end))}</mark>` : "<mark>▍</mark>") + esc(S.text.slice(r.end, b)) + (b < S.text.length ? "…" : "") });
  }
  const resolved = t.status === "resolved";
  const body = h("div", { class: "modal-body" }, t.messages.map((m) =>
    h("div", { class: "bubble " + (m.author === "ai" ? "ai" : "me") },
      h("div", { class: "msg-who" }, avatar(m.author, true), who(m), h("time", {}, rel(m.at))),
      m.kind === "question" ? h("span", { class: "tagq" }, "Question") : null,
      h("div", { class: "msg-text", html: richText(m.text) }),
      msgMeta(t, m))));
  fill(modal,
    h("div", { class: "modal-head" },
      h("h3", {}, `${t.file}${r ? " · line " + lineOf(S.text, r.start) : ""}`),
      h("button", { class: "btn small " + (resolved ? "" : "ok"), onclick: () => setThreadStatus(t, resolved ? "open" : "resolved") }, resolved ? "Reopen" : "Resolve"),
      h("button", { class: "icon-btn sm", title: "Close (Esc)", html: ICON.x, onclick: () => closeModal() })),
    ctx,
    body,
    h("div", { class: "modal-foot" }, composer({
      key: "modal:" + t.id,
      placeholder: threadKind(t) === "question" ? "Answer the AI…" : "Reply…",
      value: S.replyDrafts.get("modal:" + t.id) || "",
      submitLabel: "Reply",
      onSubmit: (v) => reply(t, v),
      onCancel: () => closeModal(),
    })));
  requestAnimationFrame(() => {
    body.scrollTop = body.scrollHeight;
    if (hadFocus) {
      const ta = modal.querySelector("textarea");
      ta?.focus();
      ta?.setSelectionRange(ta.value.length, ta.value.length);
    }
    const mk = ctx?.querySelector("mark");
    if (mk) ctx.scrollTop = mk.offsetTop - ctx.offsetTop - 40;
  });
}

function closeModal(instant = false) {
  if (!modal.classList.contains("on")) return;
  const id = modalId;
  modalId = null;
  $("modalBackdrop").classList.remove("on");
  const to = document.querySelector(`.card[data-id="${id}"]`)?.getBoundingClientRect();
  if (instant || !to) return modal.classList.remove("on");
  const from = modal.getBoundingClientRect();
  const anim = modal.animate([
    { transform: "none", opacity: 1 },
    { transform: `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(${to.width / from.width}, ${to.height / from.height})`, opacity: 0 },
  ], { duration: 240, easing: "cubic-bezier(.4,0,.2,1)" });
  anim.onfinish = () => modal.classList.remove("on");
  if (id) setActive(id);
}

$("modalBackdrop").addEventListener("click", () => closeModal());

// ---------- @ / # / slash-command autocomplete ----------

const ac = $("ac");
let acState = null;

function acPlace(ta, width, height) {
  const r = ta.getBoundingClientRect();
  ac.style.left = Math.max(8, Math.min(window.innerWidth - width - 10, r.left)) + "px";
  const below = r.bottom + 6;
  ac.style.top = (below + height > window.innerHeight ? Math.max(8, r.top - height - 6) : below) + "px";
}

function acInput(ta) {
  const before = ta.value.slice(0, ta.selectionStart);
  const m = /(^|[\s(])([@#])([\w./-]*)$/.exec(before);
  if (!m) return acCommand(ta, before);
  const [, , sigil, q] = m;
  const ql = q.toLowerCase();
  let items;
  if (sigil === "@") {
    items = S.files.filter((f) => f.path.toLowerCase().includes(ql)).slice(0, 40).map((f) => ({ value: f.path, label: f.path.split("/").pop(), hint: f.path }));
  } else {
    const used = new Set(Object.keys(S.tags));
    for (const t of S.threads) for (const msg of t.messages) for (const mm of msg.text.matchAll(/#([\w-]+)/g)) used.add(mm[1]);
    items = [...used].filter((t) => t.toLowerCase().includes(ql)).slice(0, 40).map((t) => ({ value: t, label: t, hint: S.tags[t]?.description || "" }));
  }
  if (!items.length) return acClose();
  acState = { ta, sigil, start: ta.selectionStart - q.length, items, i: 0 };
  ac.classList.remove("cmd", "hint");
  acPlace(ta, 360, 260);
  acRender();
}

// "/" at the start of a comment lists the commands; once one is typed, its parameter help stays
// up while the arguments are written on the first line.
function acCommand(ta, before) {
  const list = /^\/([\w-]*)$/.exec(before);
  if (list) {
    const q = list[1].toLowerCase();
    const items = [...COMMANDS.filter((c) => c.name.startsWith(q)), ...(q.length > 1 ? COMMANDS.filter((c) => !c.name.startsWith(q) && c.name.includes(q)) : [])]
      .map((c) => ({ value: c.name, label: c.name, def: c }));
    if (!items.length) return acClose();
    const keep = acState?.sigil === "/" ? items.findIndex((it) => it.value === acState.items[acState.i]?.value) : -1;
    acState = { ta, sigil: "/", start: 1, items, i: Math.max(0, keep) };
    ac.classList.add("cmd");
    ac.classList.remove("hint");
    acPlace(ta, 560, 300);
    return acRender();
  }
  const typed = !before.includes("\n") && /^\/([\w-]+)\s/.exec(before);
  const def = typed && findCommand(typed[1]);
  if (!def) return acClose();
  acState = { ta, hint: def };
  ac.classList.add("cmd", "hint");
  acPlace(ta, 300, 220);
  ac.replaceChildren(cmdDetail(def));
  ac.classList.add("on");
}

function cmdDetail(c) {
  return h("div", { class: "ac-detail" },
    h("div", { class: "sig" }, h("b", {}, "/" + c.name), c.args ? h("span", {}, " " + c.args) : null),
    h("p", {}, c.summary),
    h("span", { class: "act act-" + c.action }, ACTION_LABEL[c.action]),
    h("dl", {}, ...c.params.flatMap((p) => [
      h("dt", {}, p.name, p.optional ? h("small", {}, " optional") : null),
      h("dd", {}, p.desc)])),
    h("div", { class: "ex" }, ...c.examples.map((e) => h("code", {}, e))));
}

function acRender() {
  if (acState.sigil === "/") {
    const list = h("div", { class: "ac-list" }, ...acState.items.map((it, k) =>
      h("div", { class: "ac-item" + (k === acState.i ? " on" : ""), onmousedown: (e) => (e.preventDefault(), acPick(k)),
        onmousemove: () => k !== acState.i && ((acState.i = k), acRender()) },
        h("span", { class: "sym" }, "/"), h("span", {}, it.label), h("small", {}, it.def.summary))));
    ac.replaceChildren(list, cmdDetail(acState.items[acState.i].def));
    ac.classList.add("on");
    list.children[acState.i]?.scrollIntoView({ block: "nearest" });
    return;
  }
  ac.replaceChildren(...acState.items.map((it, k) =>
    h("div", { class: "ac-item" + (k === acState.i ? " on" : ""), onmousedown: (e) => (e.preventDefault(), acPick(k)) },
      h("span", { class: "sym" }, acState.sigil), h("span", {}, it.label), it.hint && it.hint !== it.label ? h("small", {}, it.hint) : null)));
  ac.classList.add("on");
  ac.children[acState.i]?.scrollIntoView({ block: "nearest" });
}

function acPick(k) {
  const { ta, start, items } = acState;
  const v = items[k].value;
  const end = ta.selectionStart;
  ta.setSelectionRange(start, end);
  if (!document.execCommand("insertText", false, v + " ")) ta.setRangeText(v + " ", start, end, "end");
  acClose();
  ta.dispatchEvent(new Event("input"));
}

function acClose() {
  acState = null;
  ac.classList.remove("on");
}

function acKeydown(e) {
  if (!acState || e.target !== acState.ta) return false;
  if (acState.hint) {
    if (e.key !== "Escape") return false;
    e.preventDefault();
    e.stopPropagation();
    acClose();
    return true;
  }
  if (e.metaKey || e.ctrlKey) {
    acClose();
    return false;
  }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    acState.i = (acState.i + (e.key === "ArrowDown" ? 1 : -1) + acState.items.length) % acState.items.length;
    acRender();
    return true;
  }
  if (e.key === "Enter" || e.key === "Tab") {
    e.preventDefault();
    acPick(acState.i);
    return true;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    acClose();
    return true;
  }
  return false;
}

// ---------- changes view ----------

function renderChanges() {
  const box = $("changes");
  if (!hasChanges()) return box.replaceChildren();
  const hunks = diffLines(S.baseline, S.text);
  const lines = splitLines(S.text);
  const kids = [h("div", { class: "changes-head" },
    h("div", { style: "flex:1" }, h("h3", {}, `${hunks.length} change${hunks.length === 1 ? "" : "s"} by the AI`), h("p", {}, "Hover a change to accept or revert it. Accepted changes stay; reverted ones go back to your text.")),
    h("button", { class: "btn small", html: ICON.undo + "<span>Revert all</span>", onclick: () => revertAll() }),
    h("button", { class: "btn primary small", html: ICON.check + "<span>Accept all</span>", onclick: () => acceptAll() }))];
  const CTX = 3;
  let at = 0;
  const ctxLines = (from, to) => {
    const out = [];
    const n = to - from;
    if (n > CTX * 2 + 1) {
      for (let i = from; i < from + (from === 0 ? 0 : CTX); i++) out.push(lineEl(lines[i], "ctx"));
      const hidden = lines.slice(from + (from === 0 ? 0 : CTX), to - CTX);
      const fold = h("button", { class: "fold" }, `⋯ ${hidden.length} unchanged line${hidden.length === 1 ? "" : "s"}`);
      fold.onclick = () => fold.replaceWith(...hidden.map((l) => lineEl(l, "ctx")));
      out.push(fold);
      for (let i = to - CTX; i < to; i++) out.push(lineEl(lines[i], "ctx"));
    } else for (let i = from; i < to; i++) out.push(lineEl(lines[i], "ctx"));
    return out;
  };
  hunks.forEach((hk) => {
    kids.push(...ctxLines(at, hk.bStart));
    const rows = [];
    const paired = hk.removed.length === hk.added.length;
    hk.removed.forEach((l, k) => rows.push(paired ? wordLine(l, hk.added[k], "del") : lineEl(l, "del")));
    hk.added.forEach((l, k) => rows.push(paired ? wordLine(hk.removed[k], l, "ins") : lineEl(l, "ins")));
    const el = h("div", { class: "hunk" },
      h("div", { class: "hunk-bar" },
        h("button", { class: "btn small", html: ICON.undo + "<span>Revert</span>", onclick: () => revertOne(hk, el) }),
        h("button", { class: "btn primary small", html: ICON.check + "<span>Accept</span>", onclick: () => acceptOne(hk, el) })),
      rows);
    kids.push(el);
    at = hk.bEnd;
  });
  const tail = ctxLines(at, lines.length);
  kids.push(...tail.slice(0, Math.min(tail.length, CTX + 1)));
  box.replaceChildren(...kids);
}

const lineEl = (l, cls) => h("div", { class: "ln " + cls }, (l ?? "").replace(/\n$/, ""));

function wordLine(a, b, side) {
  const parts = diffWords((a ?? "").replace(/\n$/, ""), (b ?? "").replace(/\n$/, ""));
  const el = h("div", { class: "ln " + side });
  for (const p of parts) {
    if (p.t === "=") el.append(p.s);
    else if (p.t === "-" && side === "del") el.append(h("span", { class: "w-del" }, p.s));
    else if (p.t === "+" && side === "ins") el.append(h("span", { class: "w-ins" }, p.s));
  }
  return el;
}

async function acceptOne(hk, el) {
  el?.classList.add("gone");
  const next = acceptHunk(S.baseline, hk);
  await api("POST", "/api/baseline", { path: S.file, text: next }).catch((err) => toast(err.message));
  S.baseline = next === S.text ? null : next;
  afterReview();
}

async function revertOne(hk, el) {
  el?.classList.add("gone");
  const next = revertHunk(S.text, hk);
  try {
    const r = await api("PUT", "/api/file", { path: S.file, text: next, baseHash: S.hash });
    S.hash = r.hash;
    const map = offsetMapper(S.text, next);
    for (const [id, rr] of S.live) S.live.set(id, mapRange(map, rr.start, rr.end));
    S.text = next;
    if (S.baseline === next) S.baseline = null;
    afterReview();
  } catch (err) {
    toast(err.message);
    renderChanges();
  }
}

async function acceptAll() {
  await api("POST", "/api/baseline", { path: S.file, text: null }).catch((err) => toast(err.message));
  S.baseline = null;
  toast("Accepted");
  afterReview();
}

async function revertAll() {
  const base = S.baseline;
  try {
    const r = await api("PUT", "/api/file", { path: S.file, text: base, baseHash: S.hash });
    S.hash = r.hash;
    S.text = base;
    S.baseline = null;
    resolveAll();
    await api("POST", "/api/baseline", { path: S.file, text: null });
    toast("Reverted");
    afterReview();
  } catch (err) {
    toast(err.message);
  }
}

function afterReview() {
  setTimeout(() => {
    if (!hasChanges()) {
      S.baselines.delete(S.file);
      renderSidebar();
      setMode(modesFor()[0]);
      updateLock();
    } else {
      renderModes();
      renderChanges();
    }
  }, 220);
}

// ---------- PDF ----------

let pdfTimer = null;
function schedulePdf() {
  clearTimeout(pdfTimer);
  pdfTimer = setTimeout(compilePdf, 1200);
}

let pdfCompile = 0;
async function compilePdf() {
  if (S.mode !== "pdf" || !S.file) return;
  const run = ++pdfCompile;
  if (S.dirty) await save();
  const status = $("pdfStatus");
  status.replaceChildren(h("span", { class: "agent-pill working" }, h("i"), h("span", {}, "Compiling…")));
  try {
    const r = await api("POST", "/api/latex", { path: S.file });
    if (run !== pdfCompile) return;
    if (r.ok) {
      const sc = $("scroller");
      const top = S.pdfScroll ?? sc.scrollTop;
      S.pdfScroll = null;
      const pages = $("pdfPages");
      const built = await renderPdf(r.pdf, pages.clientWidth);
      if (run !== pdfCompile || S.mode !== "pdf") return;
      pages.replaceChildren(...built);
      status.replaceChildren();
      S.pdfBoxes = new Map();
      S.pdfHash = S.hash;
      sc.scrollTo({ top, behavior: "instant" });
      renderCards();
      paintPdf();
    } else {
      const line = r.error?.line;
      status.replaceChildren(h("div", { class: "pdf-error" },
        h("b", {}, "LaTeX error"), h("span", { style: "flex:1" }, `${r.error?.message || "failed"}${line ? ` (line ${line})` : ""}`),
        line ? h("button", { class: "btn small", onclick: () => goToLine(line) }, "Show line") : null));
    }
  } catch (err) {
    status.replaceChildren(h("div", { class: "pdf-error" }, h("b", {}, "Error"), err.message));
  }
}

// ---------- comments on the PDF ----------
// Highlights come from SyncTeX (source line -> boxes on the page). A comment made on the PDF
// also stores the exact rectangles that were selected; those win while the source is unchanged.

let pdfPaint = 0;
async function paintPdf() {
  const root = $("pdfPages");
  if (!root.querySelector(".pdf-page")) return;
  const run = ++pdfPaint;
  const items = rangesForRender().map((r) => {
    const t = S.threads.find((x) => x.id === r.id);
    const pdf = r.id === "draft" ? S.draft?.pdf : t?.pdf;
    const exact = pdf?.rects?.length && pdf.textHash === S.hash && S.pdfHash === S.hash ? pdf.rects : null;
    const la = lineOf(S.text, r.start);
    const lb = r.end > r.start ? lineOf(S.text, r.end - 1) : la;
    return { ...r, exact, la, lb: Math.min(lb, la + 80) };
  });
  // Lines such as \] or \begin{center} produce nothing on the page; then the nearest line after
  // (or before) that does stands in, so the card still sits next to the right spot.
  const near = (it) => [...Array(6).keys()].slice(1).flatMap((d) => [it.lb + d, it.la - d]).filter((l) => l > 0);
  const need = new Set();
  for (const it of items) if (!it.exact) for (const l of [...Array(it.lb - it.la + 1).keys()].map((k) => it.la + k).concat(near(it))) if (!S.pdfBoxes?.has(l)) need.add(l);
  if (need.size && S.synctex) {
    try {
      const { boxes } = await api("POST", "/api/synctex", { op: "view", path: S.file, lines: [...need] });
      for (const l of need) S.pdfBoxes.set(l, boxes[l] || []);
    } catch {}
  }
  if (run !== pdfPaint || S.mode !== "pdf") return;
  paintMarks(root, items.map((it) => {
    let rects = it.exact;
    if (!rects) {
      rects = [];
      for (let l = it.la; l <= it.lb; l++) rects.push(...(S.pdfBoxes?.get(l) || []));
      for (const l of rects.length ? [] : near(it)) {
        const b = S.pdfBoxes?.get(l) || [];
        if (b.length) {
          rects = l < it.la ? b.slice(-1) : b.slice(0, 1);
          break;
        }
      }
    }
    return { id: it.id, kind: it.kind, rects, pin: it.start === it.end };
  }));
  markActive();
  layoutCards();
}

async function pdfLine(page, x, y) {
  const { hit } = await api("POST", "/api/synctex", { op: "edit", path: S.file, page, x, y });
  if (!hit || (hit.file && !hit.file.endsWith("/" + S.file.split("/").pop()))) return null;
  return hit.line;
}

async function pdfMouseUp(e) {
  if (e.target.closest(".card, .add-chip, .modal, .top, .sidebar, .autocomplete")) return;
  const root = $("pdfPages");
  const sel = window.getSelection();
  const moved = mouseDownAt && Math.hypot(e.clientX - mouseDownAt.x, e.clientY - mouseDownAt.y) > 4;
  try {
    if (sel.rangeCount && !sel.isCollapsed && root.contains(sel.anchorNode)) {
      const range = sel.getRangeAt(0);
      const quote = sel.toString().replace(/\s+/g, " ").trim();
      const rects = rangeRects(root, range);
      if (!quote || !rects.length) return hideChip();
      const top = range.getBoundingClientRect().top;
      const a = rects[0];
      const b = rects[rects.length - 1];
      const [la, lb] = await Promise.all([pdfLine(a.page, a.x + 1, a.y + a.h / 2), pdfLine(b.page, b.x + b.w - 1, b.y + b.h / 2)]);
      if (!la) return toast("Couldn't find that text in the source. Comment on it in Source instead.");
      const m = matchInSource(S.text, quote, la, lb ?? la);
      return showChip({ start: m.start, end: m.end, pdf: { quote, rects, textHash: S.hash } }, top);
    }
    if (moved || !e.target.closest(".pdf-page")) return hideChip();
    const hits = marksAt(root, e.clientX, e.clientY);
    if (hits.length) {
      hideChip();
      return setActive(hits[(hits.indexOf(S.active) + 1) % hits.length]);
    }
    const pageEl = pageAt(root, e.clientX, e.clientY);
    const p = toPdf(pageEl, e.clientX, e.clientY);
    const line = await pdfLine(p.page, p.x, p.y);
    if (!line) return hideChip();
    const c = caretAt(e.clientX, e.clientY);
    const t = c?.node?.nodeType === Node.TEXT_NODE ? c.node.textContent : "";
    const word = (t.slice(0, c?.offset ?? 0).match(/[\p{L}\p{N}]+$/u)?.[0] || "") + (t.slice(c?.offset ?? 0).match(/^[\p{L}\p{N}]+/u)?.[0] || "");
    const pos = pointInSource(S.text, word, line);
    const span = e.target.closest(".textLayer span");
    const r = span ? span.getBoundingClientRect() : null;
    const at = r ? toPdf(pageEl, e.clientX, r.top) : { ...p, y: p.y - 6 };
    showChip({ start: pos, end: pos, pdf: { quote: "", rects: [{ page: p.page, x: at.x, y: at.y, w: 1, h: r ? r.height / Number(pageEl.dataset.scale) : 12 }], textHash: S.hash } }, e.clientY - 12);
  } catch (err) {
    toast(err.message);
  }
}

function goToLine(n) {
  setMode("edit");
  const lines = S.text.split("\n");
  const start = lines.slice(0, n - 1).join("\n").length + (n > 1 ? 1 : 0);
  const end = start + (lines[n - 1] || "").length;
  src.focus();
  src.setSelectionRange(start, end);
  const r = backdropRect(start);
  const sc = $("scroller");
  sc.scrollBy({ top: r.top - sc.getBoundingClientRect().top - 200 });
}

// ---------- send ----------

async function send() {
  if (!S.pending) return toast("Nothing to send yet. Add a comment first.");
  if (S.dirty) await save();
  const btn = $("sendBtn");
  btn.animate([{ transform: "scale(1)" }, { transform: "scale(0.95)" }, { transform: "scale(1)" }], { duration: 260, easing: "ease-out" });
  try {
    const r = await api("POST", "/api/submit");
    toast(r.agentWaiting ? `Sent ${r.threads} comment${r.threads === 1 ? "" : "s"} to the AI` : `Queued ${r.threads} comment${r.threads === 1 ? "" : "s"}. The AI gets them as soon as it listens.`);
    scheduleRefresh();
  } catch (err) {
    toast(err.message);
  }
}

// ---------- toasts ----------

function toast(text, { action, onAction, ms = 4200 } = {}) {
  const t = h("div", { class: "toast" }, h("span", {}, text),
    action ? h("button", { class: "btn small", onclick: () => (onAction?.(), dismiss()) }, action) : null);
  const dismiss = () => {
    t.classList.add("out");
    setTimeout(() => t.remove(), 260);
  };
  $("toasts").append(t);
  while ($("toasts").children.length > 3) $("toasts").firstChild.remove();
  setTimeout(dismiss, ms);
}

// ---------- quick search (⌘K / Ctrl-K) ----------

const palette = $("palette");
let pal = null;
let palTimer = null;

function openPalette() {
  if (palette.classList.contains("on")) return $("paletteInput").select();
  pal = { items: [], i: 0, seq: 0 };
  palette.classList.add("on");
  $("paletteBackdrop").classList.add("on");
  paletteSearch();
  $("paletteInput").focus();
  requestAnimationFrame(() => $("paletteInput").select());
}

function closePalette() {
  clearTimeout(palTimer);
  pal = null;
  if (!palette.classList.contains("on")) return;
  palette.classList.remove("on");
  $("paletteBackdrop").classList.remove("on");
}

// Files whose path contains the query; a hit on the file name itself ranks above one on the folder.
function fileHits(q) {
  const files = S.files.filter((f) => f.editable);
  if (!q) return files.slice(0, 12).map((f) => ({ type: "file", path: f.path }));
  const needle = q.toLowerCase();
  return files
    .map((f) => ({ f, at: f.path.toLowerCase().indexOf(needle) }))
    .filter((x) => x.at !== -1)
    .map((x) => ({ ...x, base: x.at > x.f.path.lastIndexOf("/") }))
    .sort((a, b) => b.base - a.base || a.at - b.at)
    .slice(0, 12)
    .map((x) => ({ type: "file", path: x.f.path }));
}

function paletteSearch() {
  if (!pal) return;
  const q = $("paletteInput").value.trim();
  const files = fileHits(q);
  pal.items = files;
  pal.i = 0;
  clearTimeout(palTimer);
  if (q.length < 2) return renderPalette(q, "");
  renderPalette(q, "searching the text…");
  const seq = ++pal.seq;
  palTimer = setTimeout(async () => {
    let hits = [];
    try {
      hits = (await api("GET", "/api/search?q=" + encodeURIComponent(q))).hits;
    } catch {
      if (pal?.seq === seq) renderPalette(q, "text search failed");
      return;
    }
    if (!pal || pal.seq !== seq) return;
    pal.items = [...files, ...hits.map((x) => ({ ...x, type: "text" }))];
    pal.i = Math.min(pal.i, Math.max(0, pal.items.length - 1));
    renderPalette(q, hits.length ? `${hits.length} text hit${hits.length === 1 ? "" : "s"}` : "no text hits");
  }, 160);
}

function renderPalette(q, hint) {
  const list = $("paletteList");
  $("paletteHint").textContent = hint;
  if (!pal.items.length) {
    list.replaceChildren(h("div", { class: "pal-none" }, q ? "Nothing matches" : "No files to open"));
    return;
  }
  const kids = [];
  let section = null;
  pal.items.forEach((it, i) => {
    if (it.type !== section) {
      section = it.type;
      kids.push(h("div", { class: "pal-head" }, section === "file" ? "Files" : "In the text"));
    }
    const row = h("button", {
      class: "pal-row" + (i === pal.i ? " on" : ""), "data-i": i,
      onclick: () => openHit(it),
      onmousemove: () => setPalIndex(i),
    },
      h("span", { class: "pal-ic", html: it.type === "file" ? ICON.file : ICON.quote }),
      it.type === "file"
        ? h("span", { class: "pal-main" }, mark(it.path, q))
        : h("span", { class: "pal-main" },
            h("span", { class: "pal-snip", html: esc(it.snippet.slice(0, it.mark[0])) + "<b>" + esc(it.snippet.slice(it.mark[0], it.mark[1])) + "</b>" + esc(it.snippet.slice(it.mark[1])) }),
            h("span", { class: "pal-where" }, `${it.path} · line ${it.line}`)));
    kids.push(row);
  });
  list.replaceChildren(...kids);
}

// Query matches bolded inside a plain string.
function mark(text, q) {
  const at = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (at === -1) return h("span", {}, text);
  return h("span", { html: esc(text.slice(0, at)) + "<b>" + esc(text.slice(at, at + q.length)) + "</b>" + esc(text.slice(at + q.length)) });
}

function setPalIndex(i) {
  if (!pal || !pal.items.length) return;
  pal.i = (i + pal.items.length) % pal.items.length;
  const list = $("paletteList");
  for (const r of list.querySelectorAll(".pal-row")) r.classList.toggle("on", Number(r.dataset.i) === pal.i);
  list.querySelector(".pal-row.on")?.scrollIntoView({ block: "nearest" });
}

function paletteKeydown(e) {
  if (!pal) return;
  if (e.key === "Escape") return e.preventDefault(), closePalette();
  if (e.key === "ArrowDown") return e.preventDefault(), setPalIndex(pal.i + 1);
  if (e.key === "ArrowUp") return e.preventDefault(), setPalIndex(pal.i - 1);
  if (e.key === "Enter") {
    e.preventDefault();
    const it = pal.items[pal.i];
    if (it) openHit(it);
  }
}

async function openHit(it) {
  closePalette();
  if (it.path !== S.file) await openFile(it.path);
  if (it.type === "text") revealOffset(it.start, it.end);
}

// Scroll a source range into view and select it, in whichever mode can show it.
function revealOffset(start, end) {
  const a = Math.min(start, S.text.length);
  const b = Math.min(end, S.text.length);
  const sc = $("scroller");
  if (S.mode === "read") {
    const r = selectSource(a, b);
    if (r) return void sc.scrollBy({ top: r.getBoundingClientRect().top - sc.getBoundingClientRect().top - 160, behavior: "instant" });
  }
  if (S.mode !== "edit") {
    if (!modesFor().includes("edit")) return;
    setMode("edit");
  }
  src.focus();
  src.setSelectionRange(a, b);
  const r = backdropRect(a);
  sc.scrollBy({ top: r.top - sc.getBoundingClientRect().top - 180, behavior: "instant" });
}

// ---------- wiring ----------

function wire() {
  $("sendBtn").addEventListener("click", send);
  $("sidebarToggle").addEventListener("click", () => {
    const hidden = !$("sidebar").classList.contains("hidden");
    $("sidebar").classList.toggle("hidden", hidden);
    store.set("sidebarHidden", hidden);
    setTimeout(layoutCards, 320);
  });
  $("fileFilter").addEventListener("input", () => renderSidebar());
  let sideScrollTimer = null;
  $("fileList").addEventListener("scroll", () => {
    clearTimeout(sideScrollTimer);
    sideScrollTimer = setTimeout(() => {
      try {
        sessionStorage.setItem(sideScrollKey, String($("fileList").scrollTop));
      } catch {}
    }, 150);
  }, { passive: true });
  $("fileName").addEventListener("click", toggleOutline);
  $("openRecipes").addEventListener("click", openRecipes);
  $("recBackdrop").addEventListener("click", () => closeRecipes());
  $("collapseAll").addEventListener("click", () => setCollapsed(allDirs()));
  $("expandAll").addEventListener("click", () => setCollapsed([]));
  $("paletteBackdrop").addEventListener("click", () => closePalette());
  $("paletteInput").addEventListener("input", paletteSearch);
  $("paletteInput").addEventListener("keydown", paletteKeydown);
  $("showResolved").addEventListener("change", (e) => {
    S.showResolved = e.target.checked;
    store.set("showResolved", S.showResolved);
    renderView();
  });
  window.addEventListener("resize", () => {
    if (S.mode === "edit") paintBackdrop();
    layoutCards();
    hideChip();
  });
  $("doc").addEventListener("mouseover", (e) => {
    const el = e.target.closest?.("[data-note]");
    if (el) showNoteTip(el);
    else hideNoteTip();
  });
  $("doc").addEventListener("mouseleave", hideNoteTip);
  $("scroller").addEventListener("scroll", () => (hideChip(), hideNoteTip(), closeOutline()), { passive: true });
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#outline, #fileName")) closeOutline();
  });
  new ResizeObserver(() => layoutCards()).observe($("docCol"));

  document.addEventListener("keydown", (e) => {
    // Quick search everywhere but inside a textarea, where ⌘K still inserts a link.
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k" && e.target.tagName !== "TEXTAREA") {
      e.preventDefault();
      return openPalette();
    }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "o") {
      e.preventDefault();
      return toggleOutline();
    }
    if (e.key === "Escape") {
      if (palette.classList.contains("on")) return closePalette();
      if (outlineBox.classList.contains("on")) return closeOutline();
      if (rec) return closeRecipes();
      if (modal.classList.contains("on")) return closeModal();
      if (S.draft) return cancelDraft();
      if (S.chip) return hideChip();
      if (S.active) return setActive(null);
    }
    const inField = e.target.closest?.("textarea, input");
    const cmd = shortcut(e);
    if (cmd === "send") return e.preventDefault(), send();
    if (inField) return;
    if (S.mode !== "read" || !S.file) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
      if (!S.undo.length) return;
      e.preventDefault();
      setText(S.undo.pop());
      save();
      return;
    }
    if (!cmd || cmd === "indent" || cmd === "outdent") return;
    const sel = selectionToSource($("doc"));
    if (cmd === "comment") {
      e.preventDefault();
      if (sel) startDraft(sel.start, sel.end);
      return;
    }
    if (cmd === "save") return e.preventDefault();
    if (!sel || sel.collapsed) return;
    const edit = command(cmd, S.text, sel.start, sel.end, S.kind);
    if (!edit) return;
    e.preventDefault();
    if (editLocked()) return lockedHint();
    applyEdit(edit);
    // Keep the formatted text selected.
    requestAnimationFrame(() => selectSource(edit.selStart, edit.selEnd));
  });
}

// Select a source range in the reading view (after a formatting shortcut, a re-render or a reload).
function selectSource(a, b) {
  const doc = $("doc");
  const segs = [...doc.querySelectorAll(".seg")];
  const find = (pos, end) => {
    for (const s of segs) {
      const st = Number(s.dataset.s);
      const len = s.textContent.length;
      if (pos >= st && (end ? pos <= st + len : pos < st + len)) return { node: s.firstChild, off: pos - st };
    }
    return null;
  };
  const p = find(a, false);
  const q = find(b, true);
  if (!p || !q) return null;
  const r = document.createRange();
  r.setStart(p.node, p.off);
  r.setEnd(q.node, q.off);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
  return r;
}

boot();
