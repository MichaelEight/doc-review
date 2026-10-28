// Compile a .tex file to PDF for the preview pane. Uses latexmk when present, else pdflatex
// (twice when the log asks for a rerun). Output goes to <root>/.doc-review/build/.
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
    res = await run(latexmk, ["-pdf", "-interaction=nonstopmode", "-halt-on-error", `-outdir=${outDir}`, path.basename(abs)], cwd);
  } else {
    const args = ["-interaction=nonstopmode", "-halt-on-error", `-output-directory=${outDir}`, path.basename(abs)];
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
