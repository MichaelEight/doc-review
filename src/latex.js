// Compile a .tex file to PDF for the preview pane. Uses latexmk when present, else pdflatex
// (twice when the log asks for a rerun). Output goes to <root>/.doc-review/build/. Builds carry
// SyncTeX data, which maps PDF positions to source lines and back so the PDF can be commented.
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const TEX_PATHS = ["/Library/TeX/texbin", "/usr/local/texlive/bin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];
const env = { ...process.env, PATH: [...TEX_PATHS, process.env.PATH].join(":") };

function which(cmd) {
  try {
    return execFileSync("/usr/bin/which", [cmd], { env, encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

const run = (cmd, args, cwd) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd, env, timeout: 90_000, maxBuffer: 8 << 20 }, (err, stdout, stderr) =>
      resolve({ code: err ? err.code ?? 1 : 0, out: String(stdout) + String(stderr) }));
  });

export function latexAvailable() {
  return Boolean(which("latexmk") || which("pdflatex"));
}

export function synctexAvailable() {
  return Boolean(which("synctex"));
}

const pdfPath = (ws, rel) => path.join(ws.dir, "build", path.dirname(rel), path.basename(rel, ".tex") + ".pdf");

function records(out) {
  const recs = [];
  let cur = null;
  for (const line of out.split("\n")) {
    const m = /^(\w+):(.*)$/.exec(line.trim());
    if (!m) continue;
    if (m[1] === "Output") recs.push((cur = {}));
    else if (cur) cur[m[1]] = m[2];
  }
  return recs;
}

// PDF point (page, x, y in big points from the page's top-left) -> source line.
export async function synctexEdit(ws, rel, page, x, y) {
  const tool = which("synctex");
  if (!tool) return null;
  const res = await run(tool, ["edit", "-o", `${page}:${x}:${y}:${pdfPath(ws, rel)}`], path.dirname(ws.resolve(rel)));
  const r = records(res.out).find((x) => x.Line);
  return r ? { line: Number(r.Line), file: r.Input ? path.normalize(r.Input) : null } : null;
}

// Source lines -> boxes on the PDF ({ page, x, y, w, h }, big points from the top-left).
export async function synctexView(ws, rel, lines) {
  const tool = which("synctex");
  const out = {};
  if (!tool) return out;
  const abs = ws.resolve(rel);
  for (const line of lines) {
    const res = await run(tool, ["view", "-i", `${line}:0:${path.basename(abs)}`, "-o", pdfPath(ws, rel)], path.dirname(abs));
    const seen = new Set();
    out[line] = records(res.out)
      .map((r) => ({ page: Number(r.Page), x: Number(r.h), y: Number(r.v) - Number(r.H), w: Number(r.W), h: Number(r.H) }))
      .filter((b) => b.page > 0 && b.w > 0 && b.h > 0 && !seen.has(JSON.stringify(b)) && seen.add(JSON.stringify(b)));
  }
  return out;
}

// Pull the first "! ..." error with its line number out of a LaTeX log.
function firstError(log) {
  const i = log.indexOf("\n! ");
  if (i < 0) return null;
  const chunk = log.slice(i + 1, i + 600).split("\n");
  const line = chunk.find((l) => /^l\.\d+/.test(l));
  return { message: chunk[0].slice(2), line: line ? Number(line.match(/^l\.(\d+)/)[1]) : null };
}

export async function compileLatex(ws, rel) {
  const abs = ws.resolve(rel);
  const outDir = path.join(ws.dir, "build", path.dirname(rel));
  fs.mkdirSync(outDir, { recursive: true });
  const cwd = path.dirname(abs);
  const base = path.basename(abs, ".tex");
  const latexmk = which("latexmk");
  const pdflatex = which("pdflatex");
  if (!latexmk && !pdflatex) {
    return { ok: false, error: "No LaTeX found. Install BasicTeX (`brew install --cask basictex`, ~100 MB) or MacTeX." };
  }
  let res;
  if (latexmk) {
    res = await run(latexmk, ["-pdf", "-synctex=1", "-interaction=nonstopmode", "-halt-on-error", `-outdir=${outDir}`, path.basename(abs)], cwd);
  } else {
    const args = ["-synctex=1", "-interaction=nonstopmode", "-halt-on-error", `-output-directory=${outDir}`, path.basename(abs)];
    res = await run(pdflatex, args, cwd);
    if (res.code === 0 && /Rerun to get|Label\(s\) may have changed/.test(res.out)) res = await run(pdflatex, args, cwd);
  }
  const pdf = path.join(outDir, base + ".pdf");
  let log = "";
  try {
    log = fs.readFileSync(path.join(outDir, base + ".log"), "utf8");
  } catch {
    log = res.out;
  }
  const ok = res.code === 0 && fs.existsSync(pdf);
  return { ok, pdf: ok ? pdf : null, error: ok ? null : firstError(log) ?? { message: "LaTeX failed", line: null }, log: log.slice(-4000) };
}
