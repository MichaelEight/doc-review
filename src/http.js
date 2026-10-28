// Local HTTP server for the review UI: static files, a small JSON API and a server-sent event
// stream per workspace. Binds 127.0.0.1 only; every API call carries a token so other web pages
// open in the browser cannot drive it. The token is kept in the user's config dir, so a restarted
// server accepts the tabs that are already open.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { compileLatex, latexAvailable } from "./latex.js";

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web");
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".pdf": "application/pdf", ".json": "application/json", ".txt": "text/plain; charset=utf-8",
};

// DOC_REVIEW_TOKEN_FILE overrides the location (tests, several users on one machine).
const TOKEN_FILE = process.env.DOC_REVIEW_TOKEN_FILE || path.join(os.homedir(), ".config", "doc-review", "token");

function loadToken() {
  try {
    const t = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    if (/^[0-9a-f]{32}$/.test(t)) return t;
  } catch {}
  const t = crypto.randomBytes(16).toString("hex");
  try {
    fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true, mode: 0o700 });
    fs.writeFileSync(TOKEN_FILE, t + "\n", { mode: 0o600 });
  } catch {}
  return t;
}

export class ReviewHttp {
  constructor(registry) {
    this.registry = registry;
    this.token = loadToken();
    this.server = null;
    this.port = null;
  }

  async listen(port = Number(process.env.DOC_REVIEW_PORT) || 4848) {
    if (this.server) return this.port;
    for (let p = port; p < port + 30; p++) {
      const ok = await new Promise((resolve) => {
        const srv = http.createServer((req, res) => this.handle(req, res));
        srv.once("error", () => resolve(false));
        srv.listen(p, "127.0.0.1", () => {
          this.server = srv;
          resolve(true);
        });
      });
      if (ok) return (this.port = p);
    }
    throw new Error(`no free port in ${port}..${port + 29}`);
  }

  url(ws, file) {
    const q = new URLSearchParams({ ws: ws.id, t: this.token });
    if (file) q.set("file", file);
    return `http://127.0.0.1:${this.port}/?${q}`;
  }

  async handle(req, res) {
    const url = new URL(req.url, "http://x");
    try {
      if (url.pathname === "/" || url.pathname.startsWith("/static/")) return this.serveStatic(url, res);
      if (!url.pathname.startsWith("/api/")) return send(res, 404, { error: "not found" });
      const token = req.headers["x-token"] || url.searchParams.get("t");
      if (token !== this.token) return send(res, 403, { error: "bad token" });
      const ws = this.registry.get(url.searchParams.get("ws"));
      if (!ws) return send(res, 404, { error: "unknown workspace (was the agent session closed?)" });
      return await this.api(ws, req, res, url);
    } catch (err) {
      return send(res, err.status || 400, { error: err.message, current: err.current });
    }
  }

  serveStatic(url, res) {
    const rel = url.pathname === "/" ? "index.html" : url.pathname.slice("/static/".length);
    const abs = path.resolve(WEB, rel);
    if (!abs.startsWith(WEB + path.sep) || !fs.existsSync(abs)) return send(res, 404, { error: "not found" });
    res.writeHead(200, { "content-type": MIME[path.extname(abs)] || "application/octet-stream", "cache-control": "no-cache" });
    fs.createReadStream(abs).pipe(res);
  }

  async api(ws, req, res, url) {
    const route = `${req.method} ${url.pathname}`;
    const body = ["POST", "PUT", "PATCH"].includes(req.method) ? await readJson(req) : {};
    const q = (k) => url.searchParams.get(k);
    const tm = url.pathname.match(/^\/api\/threads\/([\w]+)(?:\/messages\/?([\w]*))?$/);

    if (route === "GET /api/state") {
      return send(res, 200, {
        id: ws.id, root: ws.root, name: ws.name, files: ws.listFiles(), threads: ws.state.threads, tags: ws.state.tags,
        baselines: Object.keys(ws.baselines), latex: latexAvailable(), ...ws.status(),
      });
    }
    if (route === "GET /api/events") return this.events(ws, req, res);
    if (route === "GET /api/file") return send(res, 200, ws.readFile(q("path")));
    if (route === "PUT /api/file") return send(res, 200, ws.writeFile(body.path, String(body.text ?? ""), body.baseHash));
    if (route === "GET /api/raw") {
      const abs = ws.resolve(q("path"));
      res.writeHead(200, { "content-type": MIME[path.extname(abs).toLowerCase()] || "application/octet-stream" });
      return fs.createReadStream(abs).pipe(res);
    }
    if (route === "POST /api/baseline") return send(res, 200, (ws.setBaseline(body.path, body.text ?? null), { ok: true }));
    if (route === "POST /api/threads") return send(res, 200, ws.addThread({ file: body.file, anchor: body.anchor, text: body.text }));
    if (tm && !tm[2] && tm[0].endsWith("/messages") && req.method === "POST") return send(res, 200, ws.addMessage(tm[1], { author: "user", text: body.text }));
    if (tm && tm[2] && req.method === "PATCH") return send(res, 200, (ws.editMessage(tm[1], tm[2], String(body.text ?? "")), { ok: true }));
    if (tm && tm[2] && req.method === "DELETE") return send(res, 200, (ws.deleteMessage(tm[1], tm[2]), { ok: true }));
    if (tm && !url.pathname.includes("/messages") && req.method === "PATCH") return send(res, 200, ws.setStatus(tm[1], body.status));
    if (tm && !url.pathname.includes("/messages") && req.method === "DELETE") return send(res, 200, (ws.deleteThread(tm[1]), { ok: true }));
    if (route === "POST /api/submit") return send(res, 200, ws.submit());
    if (route === "POST /api/latex") {
      const out = await compileLatex(ws, body.path);
      return send(res, 200, { ...out, pdf: out.pdf ? `/api/pdf?ws=${ws.id}&t=${this.token}&path=${encodeURIComponent(body.path)}&v=${Date.now()}` : null });
    }
    if (route === "GET /api/pdf") {
      const rel = q("path");
      ws.resolve(rel);
      const pdf = path.join(ws.dir, "build", path.dirname(rel), path.basename(rel, ".tex") + ".pdf");
      if (!fs.existsSync(pdf)) return send(res, 404, { error: "not compiled yet" });
      res.writeHead(200, { "content-type": "application/pdf", "cache-control": "no-store" });
      return fs.createReadStream(pdf).pipe(res);
    }
    return send(res, 404, { error: `no route ${route}` });
  }

  events(ws, req, res) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const write = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
    write({ type: "status", ...ws.status() });
    const off = ws.on(write);
    const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
    req.on("close", () => {
      off();
      clearInterval(ping);
    });
  }

  close() {
    this.server?.close();
    this.server?.closeAllConnections?.();
  }
}

function send(res, status, obj) {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (d) => {
      buf += d;
      if (buf.length > 8 << 20) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(buf ? JSON.parse(buf) : {});
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
  });
}
