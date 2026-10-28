// Tool definitions (JSON Schema) and handlers. Handlers may be async; review_wait blocks until the
// user presses "Send to AI" in the browser (or the timeout passes).
import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { Workspace, workspaceId } from "./workspace.js";
import { makeAnchor } from "../web/anchor.js";

const rootProp = { type: "string", description: "Absolute path of the workspace folder. Optional when only one workspace is open." };

export const TOOLS = [
  {
    name: "review_open",
    description:
      "Open a folder (or the folder of a file) in the doc-review web UI and return its URL. The user reads, edits and comments " +
      "on .md/.txt/.tex files there, then presses \"Send to AI\". Call review_wait next to receive the comments.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: { type: "string", description: "Absolute path of a folder, or of a file inside the folder to open." },
        open_browser: { type: "boolean", description: "Open the URL in the default browser (default true)." },
      },
    },
  },
  {
    name: "review_wait",
    description:
      "Block until the user presses \"Send to AI\", then return every new comment with its file, line, quoted text, context and " +
      "thread history, plus referenced @files and #tags. Ends the previous round. Returns {status:\"timeout\"} after " +
      "timeout_seconds; then call it again to keep listening.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { root: rootProp, timeout_seconds: { type: "number", minimum: 5, maximum: 3600, description: "Default 540." } },
    },
  },
  {
    name: "review_reply",
    description:
      "Post a message in a comment thread, shown in the margin next to the text. kind=question when you need the user's answer " +
      "before you can act (the answer arrives in a later review_wait); kind=note to explain or agree (e.g. \"Yeah, that's right\") " +
      "without resolving.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["comment_id", "text"],
      properties: {
        comment_id: { type: "string" },
        text: { type: "string" },
        kind: { type: "string", enum: ["note", "question"], description: "Default note." },
      },
    },
  },
  {
    name: "review_resolve",
    description: "Mark a comment as handled, with a short note shown to the user (e.g. \"Corrected\", \"Rewrote the intro as asked\").",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["comment_id"],
      properties: { comment_id: { type: "string" }, note: { type: "string" } },
    },
  },
  {
    name: "review_comment",
    description:
      "Start a new comment thread yourself, anchored on an exact quote from a file (or at the start of the file if quote is " +
      "empty). Use it to point the user at something: a doubt, a fact to check, a suggestion.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["file", "text"],
      properties: {
        root: rootProp,
        file: { type: "string", description: "Path relative to the workspace root (or absolute)." },
        quote: { type: "string", description: "Exact text from the file to anchor on." },
        occurrence: { type: "number", minimum: 1, description: "Which occurrence of quote (default 1)." },
        text: { type: "string" },
        kind: { type: "string", enum: ["note", "question"], description: "Default note." },
      },
    },
  },
  {
    name: "review_finish",
    description: "End the current round: the UI unlocks editing and shows your summary and the diff of your changes for the user to accept or revert.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { root: rootProp, summary: { type: "string", description: "One line: what you changed." } },
    },
  },
  {
    name: "review_threads",
    description: "List comment threads (all, or one file / status) with their current anchor position and messages.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { root: rootProp, file: { type: "string" }, status: { type: "string", enum: ["open", "resolved"] } },
    },
  },
  {
    name: "review_define_tag",
    description:
      "Define or update a #tag for this workspace (a concept, topic or convention, e.g. #image-gs = \"Gaussian splatting figures, " +
      "see figures/gs/\"). Tags autocomplete in the UI and their definitions are sent along whenever a comment uses them.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["name", "description"],
      properties: {
        root: rootProp,
        name: { type: "string" },
        description: { type: "string" },
        files: { type: "array", items: { type: "string" }, description: "Related files, relative to the root." },
      },
    },
  },
];

export function makeHandlers(registry, http) {
  const pick = (root) => {
    if (root) {
      const ws = registry.get(workspaceId(root));
      if (!ws) throw new Error(`workspace not open: ${root} (call review_open first)`);
      return ws;
    }
    const all = [...registry.values()];
    if (all.length === 1) return all[0];
    if (!all.length) throw new Error("no workspace open: call review_open first");
    throw new Error(`several workspaces open, pass root: ${all.map((w) => w.root).join(", ")}`);
  };
  const byComment = (id) => {
    for (const ws of registry.values()) if (ws.state.threads.some((t) => t.id === id)) return ws;
    throw new Error(`unknown comment: ${id}`);
  };
  const fileRel = (ws, file) => (path.isAbsolute(file) ? ws.rel(file) : file);

  return {
    async review_open({ path: p, open_browser = true }) {
      const abs = path.resolve(p);
      const isFile = fs.existsSync(abs) && fs.statSync(abs).isFile();
      const root = isFile ? path.dirname(abs) : abs;
      const id = workspaceId(root);
      let ws = registry.get(id);
      if (!ws) registry.set(id, (ws = new Workspace(root)));
      await http.listen();
      const url = http.url(ws, isFile ? ws.rel(abs) : null);
      if (open_browser && process.platform === "darwin") execFile("open", [url], () => {});
      else if (open_browser && process.platform === "linux") execFile("xdg-open", [url], () => {});
      const open = ws.state.threads.filter((t) => t.status === "open").length;
      return { url, root: ws.root, files: ws.listFiles().filter((f) => f.editable).length, open_comments: open, ...ws.status(),
        next: "Tell the user the URL, then call review_wait." };
    },

    async review_wait({ root, timeout_seconds = 540 }, ctx) {
      return pick(root).waitForSubmit(timeout_seconds * 1000, ctx?.signal);
    },

    review_reply({ comment_id, text, kind = "note" }) {
      const ws = byComment(comment_id);
      const m = ws.addMessage(comment_id, { author: "ai", kind, text });
      return { ok: true, message_id: m.id };
    },

    review_resolve({ comment_id, note }) {
      const ws = byComment(comment_id);
      if (note?.trim()) ws.addMessage(comment_id, { author: "ai", kind: "note", text: note });
      ws.setStatus(comment_id, "resolved", "ai");
      return { ok: true };
    },

    review_comment({ root, file, quote = "", occurrence = 1, text, kind = "note" }) {
      const ws = root ? pick(root) : path.isAbsolute(file) ? [...registry.values()].find((w) => file.startsWith(w.root + path.sep)) ?? pick() : pick();
      const rel = fileRel(ws, file);
      const body = fs.readFileSync(ws.resolve(rel), "utf8");
      let at = 0;
      if (quote) {
        at = -1;
        for (let n = 0; n < occurrence; n++) {
          at = body.indexOf(quote, at + 1);
          if (at < 0) throw new Error(`quote not found in ${rel} (occurrence ${n + 1})`);
        }
      }
      const t = ws.addThread({ file: rel, anchor: makeAnchor(body, at, at + quote.length), text, author: "ai", kind });
      return { ok: true, comment_id: t.id };
    },

    review_finish({ root, summary }) {
      const ws = pick(root);
      ws.endRound(summary ?? "");
      const changed = Object.keys(ws.baselines);
      return { ok: true, changed_files: changed, next: "Call review_wait to wait for the user's next round." };
    },

    review_threads({ root, file, status }) {
      const ws = pick(root);
      return ws.state.threads
        .filter((t) => (!file || t.file === fileRel(ws, file)) && (!status || t.status === status))
        .map((t) => ws.describeThread(t));
    },

    review_define_tag({ root, name, description, files }) {
      return pick(root).defineTag(name, description, files);
    },
  };
}
