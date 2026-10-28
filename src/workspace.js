// A review workspace: one folder, its comment threads, AI rounds and the baselines that the
// "AI changes" diff is computed against. State lives in <root>/.doc-review/ so it survives restarts.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { resolveAnchor, makeAnchor, lineOf, extractRefs } from "../web/anchor.js";
import { offsetMapper, mapRange } from "../web/remap.js";

export const EDITABLE = new Set([".md", ".markdown", ".txt", ".tex", ".bib"]);
const SKIP_DIRS = new Set(["node_modules", ".git", ".doc-review", "dist", "build", "__pycache__", ".venv", "venv"]);
const MAX_FILES = 5000;
const MAX_EDITABLE_BYTES = 2_000_000;

export const hash = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);
const newId = (p) => `${p}_${crypto.randomBytes(5).toString("hex")}`;
const now = () => new Date().toISOString();

export function workspaceId(root) {
  return hash(path.resolve(root)).slice(0, 10);
}

export class Workspace {
  constructor(root) {
    this.root = path.resolve(root);
    if (!fs.statSync(this.root).isDirectory()) throw new Error(`not a directory: ${this.root}`);
    this.id = workspaceId(this.root);
    this.name = path.basename(this.root);
    this.dir = path.join(this.root, ".doc-review");
    this.file = path.join(this.dir, "comments.json");
    this.baselineFile = path.join(this.dir, "baselines.json");
    this.listeners = new Set();
    this.waiters = [];
    this.aiWorking = false;
    // True once an AI session opened this folder through review_open (false under --serve).
    this.agentAttached = false;
    this.lastSummary = null;
    this.load();
    for (const t of this.state.threads) this.known(t.file);
    this.watch();
  }

  // ---------- persistence ----------

  load() {
    const empty = { version: 1, threads: [], rounds: [], tags: {} };
    try {
      this.state = { ...empty, ...JSON.parse(fs.readFileSync(this.file, "utf8")) };
    } catch {
      this.state = empty;
    }
    try {
      this.baselines = JSON.parse(fs.readFileSync(this.baselineFile, "utf8"));
    } catch {
      this.baselines = {};
    }
  }

  save() {
    fs.mkdirSync(this.dir, { recursive: true });
    const gi = path.join(this.dir, ".gitignore");
    if (!fs.existsSync(gi)) fs.writeFileSync(gi, "build/\nbaselines.json\n");
    this.ownWrite = JSON.stringify(this.state, null, 1);
    fs.writeFileSync(this.file, this.ownWrite);
    fs.writeFileSync(this.baselineFile, JSON.stringify(this.baselines));
  }

  watch() {
    const pending = new Map();
    try {
      this.watcher = fs.watch(this.root, { recursive: true }, (_ev, name) => {
        if (!name) return;
        const rel = name.split(path.sep).join("/");
        if (rel === ".doc-review/comments.json") return this.onStateFileChange();
        if (rel.split("/").some((p) => SKIP_DIRS.has(p))) return;
        clearTimeout(pending.get(rel));
        pending.set(rel, setTimeout(() => {
          pending.delete(rel);
          this.onFileChange(rel);
        }, 80));
      });
      this.watcher.on("error", () => {});
    } catch {
      this.watcher = null;
    }
  }

  // Another process (a second server on the same folder) wrote comments.json.
  onStateFileChange() {
    let text;
    try {
      text = fs.readFileSync(this.file, "utf8");
    } catch {
      return;
    }
    if (text === this.ownWrite) return;
    this.load();
    this.emit({ type: "threads" });
    this.wakeIfSubmitted();
  }

  // Last known text of every file that has threads, so anchors can be carried through edits.
  known(rel) {
    if (!this.contents) this.contents = new Map();
    if (!this.contents.has(rel)) {
      try {
        this.contents.set(rel, fs.readFileSync(this.resolve(rel), "utf8"));
      } catch {
        this.contents.set(rel, null);
      }
    }
    return this.contents.get(rel);
  }

  remapAnchors(rel, newText) {
    const old = this.known(rel);
    this.contents.set(rel, newText);
    if (old == null || old === newText) return;
    const threads = this.state.threads.filter((t) => t.file === rel);
    if (!threads.length) return;
    const map = offsetMapper(old, newText);
    let changed = false;
    for (const t of threads) {
      const r = resolveAnchor(old, t.anchor);
      if (!r) continue;
      const m = mapRange(map, r.start, r.end);
      const next = makeAnchor(newText, m.start, m.end);
      if (next.quote !== t.anchor.quote || next.prefix !== t.anchor.prefix || next.suffix !== t.anchor.suffix) {
        t.anchor = next;
        changed = true;
      }
    }
    if (changed) {
      this.save();
      this.emit({ type: "threads" });
    }
  }

  onFileChange(rel) {
    const abs = path.join(this.root, rel);
    if (!fs.existsSync(abs)) return this.emit({ type: "files" });
    if (EDITABLE.has(path.extname(rel).toLowerCase())) {
      try {
        this.remapAnchors(rel, fs.readFileSync(abs, "utf8"));
      } catch {}
    }
    const base = this.baselines[rel];
    if (base != null && !this.aiWorking) {
      // Drop a baseline that no longer differs (e.g. the AI touched nothing).
      try {
        if (fs.readFileSync(abs, "utf8") === base) {
          delete this.baselines[rel];
          this.save();
        }
      } catch {}
    }
    this.emit({ type: "file", path: rel });
  }

  close() {
    this.watcher?.close();
    for (const w of this.waiters) w.resolve({ status: "closed" });
    this.waiters = [];
  }

  // ---------- events ----------

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(ev) {
    for (const fn of this.listeners) {
      try {
        fn(ev);
      } catch {}
    }
  }

  status() {
    return {
      aiWorking: this.aiWorking,
      agentAttached: this.agentAttached,
      agentWaiting: this.waiters.length > 0,
      pending: this.state.threads.filter((t) => t.messages.some((m) => m.state === "pending")).length,
      lastSummary: this.lastSummary,
    };
  }

  emitStatus() {
    this.emit({ type: "status", ...this.status() });
  }

  // ---------- files ----------

  resolve(rel) {
    if (typeof rel !== "string" || !rel) throw new Error("path required");
    const abs = path.resolve(this.root, rel);
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) throw new Error(`path outside workspace: ${rel}`);
    return abs;
  }

  rel(abs) {
    return path.relative(this.root, abs).split(path.sep).join("/");
  }

  listFiles() {
    const out = [];
    const walk = (dir) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? 1 : -1));
      for (const e of entries) {
        if (out.length >= MAX_FILES) return;
        if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) walk(abs);
        else if (e.isFile()) {
          const ext = path.extname(e.name).toLowerCase();
          out.push({ path: this.rel(abs), editable: EDITABLE.has(ext), ext });
        }
      }
    };
    walk(this.root);
    return out;
  }

  readFile(rel) {
    const abs = this.resolve(rel);
    const st = fs.statSync(abs);
    if (st.size > MAX_EDITABLE_BYTES) throw new Error(`file too large to review (${st.size} bytes)`);
    const text = fs.readFileSync(abs, "utf8");
    return { path: rel, text, hash: hash(text), baseline: this.baselines[rel] ?? null };
  }

  writeFile(rel, text, baseHash) {
    const abs = this.resolve(rel);
    if (!EDITABLE.has(path.extname(abs).toLowerCase())) throw new Error("not an editable file type");
    if (this.aiWorking) {
      const err = new Error("the AI is editing right now; try again when it finishes");
      err.status = 423;
      throw err;
    }
    let current = "";
    try {
      current = fs.readFileSync(abs, "utf8");
    } catch {}
    if (baseHash && hash(current) !== baseHash) {
      const err = new Error("file changed on disk");
      err.status = 409;
      err.current = { text: current, hash: hash(current) };
      throw err;
    }
    fs.writeFileSync(abs, text);
    this.remapAnchors(rel, text);
    return { hash: hash(text) };
  }

  // Accepting a diff hunk moves the baseline toward the current text; null clears it.
  setBaseline(rel, text) {
    this.resolve(rel);
    if (text == null) delete this.baselines[rel];
    else this.baselines[rel] = text;
    try {
      if (text != null && fs.readFileSync(this.resolve(rel), "utf8") === text) delete this.baselines[rel];
    } catch {}
    this.save();
    this.emit({ type: "file", path: rel });
  }

  snapshotBaselines() {
    for (const f of this.listFiles()) {
      if (!f.editable || this.baselines[f.path] != null) continue;
      try {
        const abs = this.resolve(f.path);
        if (fs.statSync(abs).size <= MAX_EDITABLE_BYTES) this.baselines[f.path] = fs.readFileSync(abs, "utf8");
      } catch {}
    }
  }

  pruneBaselines() {
    for (const [rel, text] of Object.entries(this.baselines)) {
      try {
        if (fs.readFileSync(this.resolve(rel), "utf8") === text) delete this.baselines[rel];
      } catch {
        delete this.baselines[rel];
      }
    }
  }

  // ---------- threads ----------

  thread(id) {
    const t = this.state.threads.find((x) => x.id === id);
    if (!t) throw new Error(`unknown comment: ${id}`);
    return t;
  }

  addThread({ file, anchor, text, author = "user", kind = "comment" }) {
    this.resolve(file);
    if (!text?.trim()) throw new Error("comment text required");
    const t = {
      id: newId("c"),
      file,
      anchor: { quote: anchor?.quote ?? "", prefix: anchor?.prefix ?? "", suffix: anchor?.suffix ?? "", hint: anchor?.hint ?? null },
      author,
      status: "open",
      createdAt: now(),
      messages: [],
    };
    this.known(file);
    this.state.threads.push(t);
    this.addMessage(t.id, { author, kind, text });
    return t;
  }

  addMessage(id, { author, kind = author === "ai" ? "note" : "comment", text }) {
    const t = this.thread(id);
    if (!text?.trim()) throw new Error("text required");
    const m = { id: newId("m"), author, kind, text: text.trim(), at: now() };
    if (author === "user") m.state = "pending";
    t.messages.push(m);
    if (author === "user" && t.status === "resolved") t.status = "open";
    t.updatedAt = m.at;
    this.save();
    this.emit({ type: "threads" });
    this.emitStatus();
    return m;
  }

  editMessage(id, mid, text) {
    const t = this.thread(id);
    const m = t.messages.find((x) => x.id === mid);
    if (!m || m.author !== "user") throw new Error("only your own messages can be edited");
    m.text = text.trim();
    if (m.state !== "pending") m.state = "pending";
    this.save();
    this.emit({ type: "threads" });
    this.emitStatus();
  }

  deleteMessage(id, mid) {
    const t = this.thread(id);
    t.messages = t.messages.filter((m) => !(m.id === mid && m.author === "user"));
    if (!t.messages.length) this.state.threads = this.state.threads.filter((x) => x !== t);
    this.save();
    this.emit({ type: "threads" });
    this.emitStatus();
  }

  setStatus(id, status, by = "user") {
    const t = this.thread(id);
    if (!["open", "resolved"].includes(status)) throw new Error("status must be open or resolved");
    t.status = status;
    t.resolvedBy = status === "resolved" ? by : undefined;
    this.save();
    this.emit({ type: "threads" });
    return t;
  }

  deleteThread(id) {
    this.thread(id);
    this.state.threads = this.state.threads.filter((x) => x.id !== id);
    this.save();
    this.emit({ type: "threads" });
    this.emitStatus();
  }

  defineTag(name, description, files) {
    const key = String(name).replace(/^#/, "").trim();
    if (!/^[\w-]+$/.test(key)) throw new Error("tag names use letters, digits, - and _");
    this.state.tags[key] = { description: description ?? "", ...(files?.length ? { files } : {}), updatedAt: now() };
    this.save();
    this.emit({ type: "threads" });
    return { tag: key, ...this.state.tags[key] };
  }

  // ---------- rounds ----------

  submit() {
    const ids = [];
    for (const t of this.state.threads) {
      let any = false;
      for (const m of t.messages) if (m.state === "pending") (m.state = "submitted"), (any = true);
      if (any) ids.push(t.id);
    }
    if (!ids.length) throw new Error("nothing to send: add a comment first");
    this.state.rounds.push({ id: this.state.rounds.length + 1, submittedAt: now(), threads: ids });
    this.save();
    this.emit({ type: "threads" });
    const agentWaiting = this.waiters.length > 0;
    this.wakeIfSubmitted();
    this.emitStatus();
    return { round: this.state.rounds.length, threads: ids.length, agentWaiting };
  }

  hasSubmitted() {
    return this.state.threads.some((t) => t.messages.some((m) => m.state === "submitted"));
  }

  wakeIfSubmitted() {
    if (!this.hasSubmitted() || !this.waiters.length) return;
    const w = this.waiters.shift();
    w.resolve(this.deliver());
  }

  waitForSubmit(timeoutMs, signal) {
    this.endRound();
    if (this.hasSubmitted()) return Promise.resolve(this.deliver());
    return new Promise((resolve) => {
      const w = {
        resolve: (v) => {
          clearTimeout(timer);
          this.waiters = this.waiters.filter((x) => x !== w);
          this.emitStatus();
          resolve(v);
        },
      };
      const timer = setTimeout(() => w.resolve({ status: "timeout", hint: "Nothing sent yet. Call review_wait again to keep listening." }), timeoutMs);
      signal?.addEventListener("abort", () => w.resolve({ status: "cancelled" }));
      this.waiters.push(w);
      this.emitStatus();
    });
  }

  endRound(summary) {
    if (!this.aiWorking && summary == null) return;
    this.aiWorking = false;
    if (summary != null) this.lastSummary = { text: summary, at: now() };
    this.pruneBaselines();
    this.save();
    this.emit({ type: "round_end", summary: summary ?? null });
    this.emitStatus();
  }

  describeThread(t) {
    let text = "";
    try {
      text = fs.readFileSync(this.resolve(t.file), "utf8");
    } catch {}
    const r = resolveAnchor(text, t.anchor);
    const out = {
      id: t.id,
      file: t.file,
      abs_path: this.resolve(t.file),
      status: t.status,
      target: t.anchor.quote ? "selection" : "point",
    };
    if (r) {
      out.line = lineOf(text, r.start);
      if (t.anchor.quote) out.quote = text.slice(r.start, r.end);
      out.context_before = text.slice(Math.max(0, r.start - 160), r.start);
      out.context_after = text.slice(r.end, r.end + 160);
    } else {
      out.orphaned = true;
      out.original_quote = t.anchor.quote;
    }
    out.messages = t.messages.map((m) => ({ author: m.author, kind: m.kind, text: m.text, new: m.state === "submitted" || undefined }));
    return out;
  }

  deliver() {
    this.snapshotBaselines();
    this.aiWorking = true;
    const threads = this.state.threads.filter((t) => t.messages.some((m) => m.state === "submitted"));
    const files = {};
    const tags = {};
    const fileSet = new Set(this.listFiles().map((f) => f.path));
    const described = threads.map((t) => this.describeThread(t));
    for (const t of threads) {
      for (const m of t.messages) {
        const refs = extractRefs(m.text);
        for (const f of refs.files) if (fileSet.has(f) || fs.existsSync(path.join(this.root, f))) files["@" + f] = path.join(this.root, f);
        for (const g of refs.tags) tags["#" + g] = this.state.tags[g] ?? { description: "(undefined tag: infer from context, or define it with review_define_tag)" };
      }
      for (const m of t.messages) if (m.state === "submitted") m.state = "delivered";
    }
    const round = this.state.rounds[this.state.rounds.length - 1];
    this.save();
    this.emit({ type: "threads" });
    this.emit({ type: "round_start", threads: threads.length });
    this.emitStatus();
    return {
      status: "submitted",
      round: round?.id ?? null,
      workspace: this.root,
      comments: described,
      referenced_files: files,
      tags,
      next:
        "Work through every comment: edit the files directly, then for each comment call review_resolve (with a short note such as " +
        "\"Corrected\") or review_reply (kind=question if you need an answer; kind=note to explain without resolving). When all are " +
        "handled call review_finish with a one-line summary, then review_wait again for the next round.",
    };
  }
}
