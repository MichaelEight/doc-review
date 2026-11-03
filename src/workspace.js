// A review workspace: one folder, its comment threads, AI rounds and the baselines that the
// "AI changes" diff is computed against. State lives in <root>/.doc-review/ so it survives restarts.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { resolveAnchor, makeAnchor, lineOf, extractRefs } from "../web/anchor.js";
import { offsetMapper, mapRange } from "../web/remap.js";
import { parseCommand } from "../web/commands.js";
import { normalizeRule, rulesFor } from "../web/display.js";
import { normalizeBrief } from "../web/briefs.js";

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
    const empty = { version: 1, threads: [], rounds: [], tags: {}, styles: [], brief: null, briefPresets: [] };
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
    // Baselines first: another process (the UI server next to an agent) reloads everything when
    // comments.json changes, and must find the baselines of the same save already on disk.
    this.ownBaselineWrite = JSON.stringify(this.baselines);
    fs.writeFileSync(this.baselineFile, this.ownBaselineWrite);
    this.ownWrite = JSON.stringify(this.state, null, 1);
    fs.writeFileSync(this.file, this.ownWrite);
  }

  watch() {
    const pending = new Map();
    try {
      this.watcher = fs.watch(this.root, { recursive: true }, (_ev, name) => {
        if (!name) return;
        const rel = name.split(path.sep).join("/");
        if (rel === ".doc-review/comments.json") return this.onStateFileChange();
        if (rel === ".doc-review/baselines.json") return this.onBaselineFileChange();
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
  onBaselineFileChange() {
    let text;
    try {
      text = fs.readFileSync(this.baselineFile, "utf8");
    } catch {
      return;
    }
    if (text === this.ownBaselineWrite) return;
    try {
      this.baselines = JSON.parse(text);
    } catch {
      return;
    }
    this.emit({ type: "threads" });
  }

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

  // Plain substring search over the editable files, for the quick-search palette. Case-insensitive,
  // a few hits per file so one big file cannot fill the list.
  searchText(query, { limit = 80, perFile = 4 } = {}) {
    const needle = String(query || "").trim().toLowerCase();
    if (needle.length < 2) return [];
    const out = [];
    for (const f of this.listFiles()) {
      if (out.length >= limit) break;
      if (!f.editable) continue;
      let text;
      try {
        const abs = this.resolve(f.path);
        if (fs.statSync(abs).size > MAX_EDITABLE_BYTES) continue;
        text = fs.readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      const hay = text.toLowerCase();
      let at = hay.indexOf(needle);
      let n = 0;
      while (at !== -1 && n < perFile && out.length < limit) {
        const ls = text.lastIndexOf("\n", at - 1) + 1;
        const le = text.indexOf("\n", at) === -1 ? text.length : text.indexOf("\n", at);
        // Keep the snippet short, with the hit inside it.
        const from = Math.max(ls, at - 48);
        const to = Math.min(le, at + needle.length + 96);
        out.push({
          path: f.path,
          line: lineOf(text, at),
          start: at,
          end: at + needle.length,
          snippet: (from > ls ? "…" : "") + text.slice(from, to) + (to < le ? "…" : ""),
          mark: [(from > ls ? 1 : 0) + (at - from), (from > ls ? 1 : 0) + (at - from) + needle.length],
        });
        at = hay.indexOf(needle, at + needle.length);
        n++;
      }
    }
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

  addThread({ file, anchor, text, author = "user", kind = "comment", pdf }) {
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
    // Made on the rendered PDF: what the user actually selected there, and where, so the highlight
    // stays exact until the source changes.
    if (pdf && Array.isArray(pdf.rects)) {
      t.pdf = {
        quote: String(pdf.quote ?? "").slice(0, 2000),
        textHash: String(pdf.textHash ?? ""),
        rects: pdf.rects.slice(0, 200).map((r) => ({ page: Number(r.page) | 0, x: +r.x || 0, y: +r.y || 0, w: +r.w || 0, h: +r.h || 0 })),
      };
    }
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

  // ---------- standing instruction ----------
  //
  // One instruction the user sets for the whole folder ("collect what I mark, don't edit"). It rides
  // along with every Send until cleared; submit() snapshots it, so changing it mid-round does not
  // rewrite what the agent was already handed.

  setBrief(b) {
    const brief = normalizeBrief(b);
    if (brief?.target) this.resolve(brief.target);
    this.state.brief = brief && { ...brief, updatedAt: now() };
    this.save();
    this.emit({ type: "threads" });
    return { brief: this.state.brief };
  }

  saveBriefPreset({ name, text, target }) {
    const brief = normalizeBrief({ text, target });
    const nm = String(name ?? "").trim().slice(0, 60);
    if (!nm) throw new Error("a preset needs a name");
    if (!brief?.text) throw new Error("a preset needs instruction text");
    const list = (this.state.briefPresets || []).filter((p) => p.name !== nm);
    const preset = { id: newId("bp"), name: nm, ...brief };
    this.state.briefPresets = [...list, preset];
    this.save();
    this.emit({ type: "threads" });
    return preset;
  }

  deleteBriefPreset(id) {
    this.state.briefPresets = (this.state.briefPresets || []).filter((p) => p.id !== id);
    this.save();
    this.emit({ type: "threads" });
  }

  // What the agent receives: the instruction plus where the target file is and whether it exists.
  briefForAgent(b) {
    if (!b) return null;
    const out = { text: b.text || undefined };
    if (b.target) {
      out.target_file = b.target;
      out.target_abs_path = this.resolve(b.target);
      out.target_exists = fs.existsSync(out.target_abs_path);
    }
    return out;
  }

  // ---------- display rules ----------
  //
  // Colouring that applies to how a file is shown, never to what it contains. Rules live in
  // comments.json next to the threads, so they sync between the agent and the UI like everything
  // else and the documents themselves stay untouched.

  styleRules(file) {
    const all = this.state.styles || [];
    return file ? rulesFor(all, file) : all;
  }

  setStyleRules(rules, { replace = false } = {}) {
    const list = replace ? [] : [...(this.state.styles || [])];
    const out = [];
    for (const raw of rules) {
      const id = raw.id && list.some((r) => r.id === raw.id) ? raw.id : newId("sty");
      const rule = { ...normalizeRule(raw, id), updatedAt: now() };
      const at = list.findIndex((r) => r.id === id);
      at === -1 ? list.push(rule) : (list[at] = rule);
      out.push(rule);
    }
    this.state.styles = list;
    this.save();
    this.emit({ type: "threads" });
    return out;
  }

  // ids: the rules to drop; no ids at all clears every rule in the workspace.
  clearStyleRules(ids) {
    const before = (this.state.styles || []).length;
    this.state.styles = ids?.length ? this.state.styles.filter((r) => !ids.includes(r.id)) : [];
    this.save();
    this.emit({ type: "threads" });
    return { removed: before - this.state.styles.length };
  }

  // The UI's on/off switch. Only ever flips `enabled`, so the AI's rule survives a user turning
  // it off and back on.
  enableStyleRule(id, enabled) {
    const r = (this.state.styles || []).find((x) => x.id === id);
    if (!r) throw new Error(`unknown display rule: ${id}`);
    r.enabled = !!enabled;
    this.save();
    this.emit({ type: "threads" });
    return r;
  }

  // ---------- rounds ----------

  submit({ withBrief = true } = {}) {
    const ids = [];
    for (const t of this.state.threads) {
      let any = false;
      for (const m of t.messages) if (m.state === "pending") (m.state = "submitted"), (any = true);
      if (any) ids.push(t.id);
    }
    if (!ids.length) throw new Error("nothing to send: add a comment first");
    const brief = withBrief && this.state.brief ? normalizeBrief(this.state.brief) : null;
    // Waiting for the agent: a later Send replaces the instruction of one it has not picked up yet.
    this.state.pendingBrief = brief;
    this.state.rounds.push({ id: this.state.rounds.length + 1, submittedAt: now(), threads: ids, ...(brief ? { brief } : {}) });
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
      // The url rides along: a user who never saw the link cannot comment, and this is the one
      // moment the agent is back in control and can put it in the chat.
      const timer = setTimeout(() => w.resolve({
        status: "timeout",
        url: this.uiUrl ?? null,
        hint: "Nothing sent yet. Call review_wait again to keep listening. If you have not put the url in a chat " +
          "message yet, write it out now before you wait again, on its own line, or the user has no way in.",
      }), timeoutMs);
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
    // The rendered text the user selected in the PDF; the source range above is the best match for it.
    if (t.pdf?.quote) out.pdf_quote = t.pdf.quote;
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
    // A new user message starting with a slash command: hand the agent the command and what it means.
    const latest = [...t.messages].reverse().find((m) => m.author === "user" && m.state === "submitted");
    const cmd = latest && parseCommand(latest.text);
    if (cmd) {
      out.command = { name: cmd.name, args: cmd.args || undefined, extra: cmd.note || undefined, action: cmd.def.action, instructions: cmd.def.instructions };
    }
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
    const instruction = this.briefForAgent(this.state.pendingBrief);
    delete this.state.pendingBrief;
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
      ...(instruction ? { instruction } : {}),
      next:
        (instruction
          ? "The user set a standing instruction for this round (`instruction`). It applies to every comment and overrides " +
            "the default below wherever they conflict (if it says not to edit, leave the commented files untouched); a " +
            "comment that explicitly asks otherwise still wins for that comment. When it names a target_file, write there " +
            "(create it if target_exists is false). "
          : "") +
        "Work through every comment: edit the files directly, then for each comment call review_resolve (with a short note such as " +
        "\"Corrected\") or review_reply (kind=question if you need an answer; kind=note to explain without resolving). When all are " +
        "handled call review_finish with a one-line summary, then review_wait again for the next round. A comment with a " +
        "`command` field is a slash command: follow command.instructions with command.args (action edit = change the file and " +
        "resolve; reply = answer in the thread only; confirm = propose with kind=question and edit only after the user agrees).",
    };
  }
}
