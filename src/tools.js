// Tool definitions (JSON Schema) and handlers. Handlers may be async; review_wait blocks until the
// user presses "Send to AI" in the browser (or the timeout passes).
import path from "node:path";
import fs from "node:fs";
import { openUrl } from "./open.js";
import { Workspace, workspaceId } from "./workspace.js";
import { makeAnchor } from "../web/anchor.js";

const rootProp = { type: "string", description: "Absolute path of the workspace folder. Optional when only one workspace is open." };

export const TOOLS = [
  {
    name: "review_open",
    description:
      "Open a folder (or the folder of a file) in the doc-review web UI and return its URL. The user reads, edits and comments " +
      "on .md/.txt/.tex files there, then presses \"Send to AI\". Put the returned url in a chat message before you call " +
      "review_wait, which blocks for minutes and keeps anything said after it from reaching the user in time.",
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
      "thread history, plus referenced @files and #tags, and the user's standing `instruction` for the round if they set one " +
      "(it overrides the default of editing the files; follow it). Ends the previous round. Returns {status:\"timeout\"} after " +
      "timeout_seconds; then call it again to keep listening. This blocks for minutes, so make sure the UI url is already " +
      "in a chat message before you call it.",
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
    name: "review_style",
    description:
      "Set, list or clear display rules: colouring and notes that change how files are SHOWN in the UI and never touch what " +
      "they contain. A rule matches a literal or a regular expression in the files its scope globs select, then paints it " +
      "(colour, background, bold, italic, underline, strike, dim), attaches a note to it (on hover or inline), or both. Use it " +
      "when the user asks for something like \"colour this nick blue\", \"give the text in <> a grey background\", \"dim the " +
      "timestamps\" or \"on hover show how long since the previous line\". Rules are per workspace and persist.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: rootProp,
        op: { type: "string", enum: ["set", "list", "clear"], description: "Default set." },
        replace: { type: "boolean", description: "set: drop every existing rule first (default false, which adds and updates)." },
        ids: { type: "array", items: { type: "string" }, description: "clear: the rules to remove. Omit to remove all of them." },
        file: { type: "string", description: "list: show only the rules that apply to this file." },
        rules: {
          type: "array",
          description: "set: the rules to add or update.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["match"],
            properties: {
              id: { type: "string", description: "Update an existing rule instead of adding one." },
              label: { type: "string", description: "Short name shown in the UI's rule list, e.g. \"nick: xxSLAYERCATxx\"." },
              scope: {
                type: "array",
                items: { type: "string" },
                description: "Workspace-relative globs the rule applies to: [\"logs/*.txt\"], [\"chats/**\"], [\"notes.md\"]. " +
                  "Default [\"**\"] (every file). * stays inside one path segment, ** crosses folders.",
              },
              match: {
                type: "object",
                additionalProperties: false,
                description: "Exactly one of literal or regex.",
                properties: {
                  literal: { type: "string", description: "Plain text to match, e.g. a nick." },
                  ignoreCase: { type: "boolean", description: "literal: default true." },
                  wholeWord: { type: "boolean", description: "literal: match only whole words." },
                  regex: { type: "string", description: "JavaScript regular expression, e.g. \"<[^>]+>\" or \"^\\\\d{4}-\\\\d{2}-\\\\d{2}\"." },
                  flags: { type: "string", description: "regex: any of i, m, s (g is always on)." },
                  group: { type: "number", description: "regex: paint this capture group instead of the whole match." },
                },
              },
              style: {
                type: "object",
                additionalProperties: false,
                properties: {
                  color: { type: "string", description: "CSS colour, e.g. #e0a800 or rebeccapurple." },
                  bg: { type: "string", description: "CSS background colour. Prefer a translucent one, e.g. rgba(14,165,233,.18), so both themes stay readable." },
                  bold: { type: "boolean" },
                  italic: { type: "boolean" },
                  underline: { type: "boolean" },
                  strike: { type: "boolean" },
                  dim: { type: "boolean", description: "Fade the text, for noise like timestamps." },
                },
              },
              annotate: {
                type: "object",
                additionalProperties: false,
                required: ["text"],
                description:
                  "Attach a note to every match. The note is decoration: it is never written to the file, cannot be selected " +
                  "or copied, and shows only in the reading view (the source view has to line up with the file). A rule may " +
                  "annotate without styling.",
                properties: {
                  text: {
                    type: "string",
                    description:
                      "The note. \"$0\" is the whole match and \"$1\"… its capture groups, so \"said by $1\" works. \"{delta}\" is " +
                      "the gap from this rule's previous match, formatted \"+0h 0m 16s\", and needs delta set.",
                  },
                  show: { type: "string", enum: ["hover", "inline"], description: "hover (default) shows it in a tooltip; inline draws it right after the match." },
                  delta: {
                    type: "object",
                    additionalProperties: false,
                    description:
                      "Read each match as a time and work out the gap from the previous one, for \"{delta}\". Understands " +
                      "\"2013-11-15 16:02:59\", \"2013-11-15T16:02\" and a bare \"16:02:59\" (which wraps at midnight). The " +
                      "first match of a rule has no previous one, so it gets no note.",
                    properties: { group: { type: "number", description: "Read this capture group as the time instead of the whole match." } },
                  },
                },
              },
              enabled: { type: "boolean", description: "Default true. The user can also switch a rule off in the UI." },
            },
          },
        },
      },
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
      ws.agentAttached = true;
      ws.emitStatus();
      await http.listen();
      const url = http.url(ws, isFile ? ws.rel(abs) : null);
      ws.uiUrl = http.url(ws);
      http.ai?.detach(ws);
      if (open_browser) openUrl(url);
      const open = ws.state.threads.filter((t) => t.status === "open").length;
      return { url, root: ws.root, files: ws.listFiles().filter((f) => f.editable).length, open_comments: open, ...ws.status(),
        next: "Write the url out in a chat message FIRST, on its own line, as the literal address. Only then call " +
          "review_wait, which blocks for minutes: anything you say after it is said too late, and the user is left " +
          "with no way into the review." };
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

    review_style({ root, op = "set", rules, replace = false, ids, file }) {
      const ws = pick(root);
      if (op === "list") return { rules: ws.styleRules(file ? fileRel(ws, file) : null) };
      if (op === "clear") return ws.clearStyleRules(ids);
      if (!rules?.length) throw new Error("set needs rules (or use op=list / op=clear)");
      const saved = ws.setStyleRules(rules, { replace });
      return { ok: true, rules: saved, total: ws.styleRules().length };
    },

    review_define_tag({ root, name, description, files }) {
      return pick(root).defineTag(name, description, files);
    },
  };
}
