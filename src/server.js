#!/usr/bin/env node
// MCP server (stdio, newline-delimited JSON-RPC 2.0) + local web UI for commenting on documents and
// handing the comments to the AI. Zero dependencies on purpose, like mcp-time-estimator.
//
//   doc-review                         piped stdin (an MCP client): MCP over stdio. In a terminal: the standalone app.
//   doc-review --mcp                   force MCP over stdio (what `claude mcp add` runs)
//   doc-review [folder]                standalone app: web UI + built-in AI (bring your own API key or local model)
//   doc-review --serve <dir>           UI only, no AI: comments queue until an agent calls review_wait
import readline from "node:readline";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { openUrl } from "./open.js";
import { BuiltInAI } from "./ai.js";
import { TOOLS, makeHandlers } from "./tools.js";
import { ReviewHttp } from "./http.js";
import { Workspace, workspaceId } from "./workspace.js";

export const SERVER_INFO = { name: "doc-review", version: "0.2.0" };
const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];

export const INSTRUCTIONS =
  "Lets the user review a document in a local web UI (Google-Docs-style margin comments on .md/.txt/.tex) and hand the " +
  "comments to you. Loop: review_open(path) -> tell the user the URL -> review_wait (blocks until they press Send to AI) -> " +
  "edit the files to address each comment -> review_resolve each one with a short note, or review_reply kind=question " +
  "when you need an answer -> review_finish(summary) -> review_wait again. @path in a comment refers to a workspace file; " +
  "#tag to a concept defined with review_define_tag. On {status:\"timeout\"} just call review_wait again. " +
  "Recommended default: after telling the user the URL, run everything from review_wait on in a background subagent, " +
  "if your host has them, so the main thread stays free to talk to the user.";

export function createServer({ write = () => {}, standalone = false } = {}) {
  const registry = new Map();
  const http = new ReviewHttp(registry);
  const handlers = makeHandlers(registry, http);
  const inflight = new Map();
  let ai = null;
  if (standalone) {
    ai = new BuiltInAI(registry, handlers);
    http.ai = ai;
    http.home = {
      recent: () => readRecent(),
      open: (dir) => {
        const ws = openFolder(dir);
        return { url: http.url(ws) };
      },
    };
  }

  // Standalone: open a folder as a workspace and start the built-in AI on it.
  function openFolder(dir) {
    const root = path.resolve(dir.replace(/^~(?=$|[\\/])/, os.homedir()));
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`That folder does not exist: ${root}`);
    const id = workspaceId(root);
    let ws = registry.get(id);
    if (!ws) registry.set(id, (ws = new Workspace(root)));
    ws.standalone = true;
    rememberRecent(root);
    ai?.attach(ws);
    return ws;
  }

  async function handle(msg) {
    const { id, method, params } = msg;
    const isRequest = id !== undefined && id !== null;
    const reply = (result) => (isRequest ? { jsonrpc: "2.0", id, result } : null);
    const fail = (code, message) => (isRequest ? { jsonrpc: "2.0", id, error: { code, message } } : null);

    switch (method) {
      case "initialize": {
        const wanted = params?.protocolVersion;
        return reply({
          protocolVersion: SUPPORTED.includes(wanted) ? wanted : SUPPORTED[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        });
      }
      case "notifications/initialized":
        return null;
      case "notifications/cancelled":
        inflight.get(params?.requestId)?.abort();
        return null;
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: TOOLS });
      case "tools/call": {
        const fn = handlers[params?.name];
        if (!fn) return fail(-32602, `unknown tool: ${params?.name}`);
        const ac = new AbortController();
        inflight.set(id, ac);
        // Keep long review_wait calls alive in clients that reset their timeout on progress.
        const token = params?._meta?.progressToken;
        let n = 0;
        const beat = token != null
          ? setInterval(() => write({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: ++n, message: "waiting for the user" } }), 25_000)
          : null;
        try {
          const result = await fn(params.arguments ?? {}, { signal: ac.signal });
          return reply({ content: [{ type: "text", text: JSON.stringify(result, null, 1) }] });
        } catch (err) {
          return reply({ content: [{ type: "text", text: `error: ${err.message}` }], isError: true });
        } finally {
          clearInterval(beat);
          inflight.delete(id);
        }
      }
      default:
        return fail(-32601, `method not found: ${method}`);
    }
  }

  const close = () => {
    for (const ws of registry.values()) ws.close();
    http.close();
  };

  return { handle, registry, http, ai, openFolder, close };
}

function mainStdio() {
  const write = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
  const server = createServer({ write });
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      return;
    }
    const out = await server.handle(msg);
    if (out) write(out);
  });
  rl.on("close", () => {
    server.close();
    process.exit(0);
  });
}

const RECENT_FILE = () => path.join(process.env.DOC_REVIEW_CONFIG_DIR || path.join(os.homedir(), ".config", "doc-review"), "recent.json");

function readRecent() {
  try {
    return JSON.parse(fs.readFileSync(RECENT_FILE(), "utf8")).filter((d) => fs.existsSync(d));
  } catch {
    return [];
  }
}

function rememberRecent(root) {
  try {
    const list = [root, ...readRecent().filter((d) => d !== root)].slice(0, 8);
    fs.mkdirSync(path.dirname(RECENT_FILE()), { recursive: true });
    fs.writeFileSync(RECENT_FILE(), JSON.stringify(list));
  } catch {}
}

async function mainServe(dir) {
  const server = createServer();
  const ws = new Workspace(path.resolve(dir));
  server.registry.set(ws.id, ws);
  await server.http.listen();
  console.log(`doc-review: ${server.http.url(ws)}`);
}

// The standalone app. Used by the CLI and by the Electron wrapper.
export async function startApp({ dir = null, openBrowser = true } = {}) {
  const server = createServer({ standalone: true });
  await server.http.listen();
  const url = dir ? server.http.url(server.openFolder(dir)) : server.http.homeUrl();
  if (openBrowser) openUrl(url);
  return { server, url };
}

export function cli(args) {
  const i = args.indexOf("--serve");
  if (args.includes("--help") || args.includes("-h")) {
    console.log("doc-review [folder]       open the review app (built-in AI)\ndoc-review --mcp          run as an MCP server over stdio\ndoc-review --serve <dir>  review UI without any AI");
  } else if (i >= 0) mainServe(args[i + 1] || ".");
  else if (args.includes("--mcp") || (!process.stdin.isTTY && !args.some((a) => !a.startsWith("-")))) mainStdio();
  else {
    const dir = args.find((a) => !a.startsWith("-")) ?? null;
    startApp({ dir })
      .then(({ url }) => console.log(`Doc Review is open in your browser.\nIf it did not open, paste this into your browser:\n${url}\nPress Ctrl+C to quit.`))
      .catch((err) => {
        console.error(err.message);
        process.exit(1);
      });
  }
}

// `node src/server.js ...` keeps working; the npm bin is bin/doc-review.js.
if (process.argv[1] && fs.realpathSync(process.argv[1]).endsWith(path.join("src", "server.js"))) cli(process.argv.slice(2));
