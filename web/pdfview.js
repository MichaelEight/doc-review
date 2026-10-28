// Renders a compiled PDF with PDF.js: one canvas per page, a selectable text layer on top and a
// marks layer in between for comment highlights. Positions are exchanged in PDF big points from
// the page's top-left, the unit SyncTeX uses, so callers never deal with screen pixels.

const PDFJS = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/";
let lib = null;

function loadLib() {
  if (lib) return lib;
  lib = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = PDFJS + "pdf.min.js";
    s.crossOrigin = "anonymous";
    s.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + "pdf.worker.min.js";
      resolve(window.pdfjsLib);
    };
    s.onerror = () => {
      lib = null;
      reject(new Error("Could not load PDF.js (offline?)"));
    };
    document.head.append(s);
  });
  return lib;
}

// Build all pages off-screen, then swap them in at once so a recompile does not flash.
export async function renderPdf(container, url, width) {
  const pdfjs = await loadLib();
  const doc = await pdfjs.getDocument({ url }).promise;
  const dpr = window.devicePixelRatio || 1;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const scale = width / page.getViewport({ scale: 1 }).width;
    const vp = page.getViewport({ scale });
    const el = document.createElement("div");
    el.className = "pdf-page";
    el.dataset.page = n;
    el.dataset.scale = scale;
    el.style.width = vp.width + "px";
    el.style.height = vp.height + "px";
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(vp.width * dpr);
    canvas.height = Math.floor(vp.height * dpr);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null }).promise;
    const marks = document.createElement("div");
    marks.className = "pdf-marks";
    const text = document.createElement("div");
    text.className = "textLayer";
    text.style.setProperty("--scale-factor", scale);
    await pdfjs.renderTextLayer({ textContentSource: page.streamTextContent(), container: text, viewport: vp, textDivs: [] }).promise;
    // As in PDF.js's own viewer: while selecting, a full-size block behind the text keeps a drag
    // across the gaps between lines from snapping the selection to the end of the page.
    const end = document.createElement("div");
    end.className = "endOfContent";
    text.append(end);
    text.addEventListener("mousedown", () => end.classList.add("active"));
    el.append(canvas, marks, text);
    pages.push(el);
  }
  container.replaceChildren(...pages);
  doc.destroy();
}

document.addEventListener("mouseup", () => {
  for (const e of document.querySelectorAll(".textLayer .endOfContent.active")) e.classList.remove("active");
});

export function pageAt(container, clientX, clientY) {
  for (const p of container.querySelectorAll(".pdf-page")) {
    const r = p.getBoundingClientRect();
    if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) return p;
  }
  return null;
}

// Screen point -> { page, x, y } in big points.
export function toPdf(pageEl, clientX, clientY) {
  const r = pageEl.getBoundingClientRect();
  const s = Number(pageEl.dataset.scale);
  return { page: Number(pageEl.dataset.page), x: (clientX - r.left) / s, y: (clientY - r.top) / s };
}

// A DOM selection range -> one rect per visual line, in big points.
export function rangeRects(container, range) {
  const out = [];
  for (const r of range.getClientRects()) {
    if (r.width < 1 || r.height < 1) continue;
    const pageEl = pageAt(container, r.left + r.width / 2, r.top + r.height / 2);
    if (!pageEl) continue;
    const a = toPdf(pageEl, r.left, r.top);
    const rect = { page: a.page, x: a.x, y: a.y, w: r.width / Number(pageEl.dataset.scale), h: r.height / Number(pageEl.dataset.scale) };
    const prev = out[out.length - 1];
    // PDF.js splits a line into several spans; merge pieces of the same line.
    if (prev && prev.page === rect.page && Math.abs(prev.y - rect.y) < 2 && rect.x <= prev.x + prev.w + 6) {
      const right = Math.max(prev.x + prev.w, rect.x + rect.w);
      prev.x = Math.min(prev.x, rect.x);
      prev.w = right - prev.x;
      prev.h = Math.max(prev.h, rect.h);
    } else out.push(rect);
  }
  return out;
}

// Draw marks: [{ id, kind, rects, pin }]. Highlights carry data-ids, pins data-id, like the
// reading view, so card layout and the active state work the same way.
export function paintMarks(container, marks) {
  for (const layer of container.querySelectorAll(".pdf-marks")) layer.replaceChildren();
  for (const m of marks) {
    for (const [k, r] of m.rects.entries()) {
      const pageEl = container.querySelector(`.pdf-page[data-page="${r.page}"]`);
      if (!pageEl) continue;
      const s = Number(pageEl.dataset.scale);
      const el = document.createElement("div");
      if (m.pin) {
        if (k) break;
        el.className = `pin pin-${m.kind} pdf-pin`;
        el.dataset.id = m.id;
        el.style.left = r.x * s - 7 + "px";
        el.style.top = r.y * s + "px";
        el.style.height = Math.max(10, r.h * s) + "px";
      } else {
        el.className = `hl hl-${m.kind}`;
        el.dataset.ids = m.id;
        el.style.left = r.x * s - 1 + "px";
        el.style.top = r.y * s - 1 + "px";
        el.style.width = r.w * s + 2 + "px";
        el.style.height = r.h * s + 2 + "px";
      }
      pageEl.querySelector(".pdf-marks").append(el);
    }
  }
}

// Which mark ids sit under a screen point (the marks layer is below the text layer).
export function marksAt(container, clientX, clientY) {
  const ids = [];
  for (const el of container.querySelectorAll(".pdf-marks > *")) {
    const r = el.getBoundingClientRect();
    const pad = el.classList.contains("pin") ? 6 : 0;
    if (clientX >= r.left - pad && clientX <= r.right + pad && clientY >= r.top && clientY <= r.bottom) {
      for (const id of (el.dataset.ids || el.dataset.id || "").split(" ")) if (id && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}
