// Display rules: colouring that lives next to the document, never inside it. A rule says which
// files it applies to (globs), what to match (a literal or a regular expression) and how to paint
// it. The AI writes them through review_style; the UI turns them into highlight ranges that the
// reading view and the source backdrop draw underneath the comment highlights.
//
// Shared by the server (validation) and the browser (matching), so it stays dependency-free.

export const STYLE_KEYS = ["color", "bg", "bold", "italic", "underline", "strike", "dim"];

// Colours come from the AI, and end up in a style attribute, so only plain CSS colour syntax is
// allowed: #rgb / #rrggbb / #rrggbbaa, rgb()/rgba()/hsl()/hsla(), or a bare colour keyword.
const COLOR = /^(#[0-9a-f]{3,8}|(rgb|hsl)a?\([0-9a-z.,%/\s+-]*\)|[a-z]{3,24})$/i;

export function okColor(v) {
  return typeof v === "string" && v.length <= 64 && COLOR.test(v.trim());
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Workspace-relative glob: * stays inside one path segment, ** crosses segments, ? is one char.
export function globToRegExp(glob) {
  const body = String(glob)
    .split(/(\*\*\/|\*\*|\*|\?)/)
    .map((p) => (p === "**/" ? "(?:.*/)?" : p === "**" ? ".*" : p === "*" ? "[^/]*" : p === "?" ? "[^/]" : esc(p)))
    .join("");
  return new RegExp(`^${body}$`, "i");
}

export function matchesScope(scope, file) {
  const globs = Array.isArray(scope) && scope.length ? scope : ["**"];
  return globs.some((g) => {
    try {
      return globToRegExp(g).test(file);
    } catch {
      return false;
    }
  });
}

export function rulesFor(rules, file) {
  return (rules || []).filter((r) => r.enabled !== false && matchesScope(r.scope, file));
}

export function styleCss(style = {}) {
  const out = [];
  if (okColor(style.color)) out.push(`color:${style.color.trim()}`);
  if (okColor(style.bg)) out.push(`background-color:${style.bg.trim()}`);
  if (style.bold) out.push("font-weight:700");
  if (style.italic) out.push("font-style:italic");
  if (style.underline || style.strike) {
    out.push(`text-decoration:${[style.underline && "underline", style.strike && "line-through"].filter(Boolean).join(" ")}`);
  }
  if (style.dim) out.push("opacity:0.55");
  return out.join(";");
}

const MAX_PER_RULE = 2000;
const MAX_TOTAL = 8000;
const MAX_MS = 150;

function ruleRegExp(r) {
  if (r.match?.literal != null) {
    const lit = String(r.match.literal);
    if (!lit) return null;
    const word = r.match.wholeWord ? "\\b" : "";
    return new RegExp(word + esc(lit) + word, "g" + (r.match.ignoreCase === false ? "" : "i") + "d");
  }
  if (r.match?.regex == null) return null;
  // Only the flags a rule may ask for; g and d are ours.
  const flags = "gd" + [...new Set(String(r.match.flags || "").replace(/[^ims]/g, ""))].join("");
  return new RegExp(String(r.match.regex), flags);
}

// Ranges to paint in `text`, in rule order, each carrying the CSS of its rule. Overlaps are kept:
// a segment covered by several rules gets all of their declarations, so the later rule wins.
export function styleRanges(text, rules) {
  const out = [];
  const started = Date.now();
  for (const r of rules) {
    let re;
    try {
      re = ruleRegExp(r);
    } catch {
      continue;
    }
    if (!re) continue;
    const css = styleCss(r.style);
    if (!css) continue;
    const group = Number(r.match.group) || 0;
    let n = 0;
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(text))) {
      const span = m.indices?.[group] ?? (m[group] == null ? null : [m.index, m.index + m[group].length]);
      if (span && span[1] > span[0]) out.push({ id: r.id, start: span[0], end: span[1], css });
      // A zero-length match would spin forever.
      if (m.index === re.lastIndex) re.lastIndex++;
      if (++n >= MAX_PER_RULE || out.length >= MAX_TOTAL) break;
      if ((n & 511) === 0 && Date.now() - started > MAX_MS) break;
    }
    if (out.length >= MAX_TOTAL || Date.now() - started > MAX_MS) break;
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

// Normalises and checks what the AI sends. Throws on anything the UI could not draw.
export function normalizeRule(raw, id) {
  const r = raw || {};
  const match = r.match || {};
  const has = match.literal != null && String(match.literal) !== "";
  const isRe = match.regex != null && String(match.regex) !== "";
  if (has === isRe) throw new Error("a rule needs exactly one of match.literal or match.regex");
  if (isRe) {
    try {
      new RegExp(String(match.regex), "gd" + String(match.flags || "").replace(/[^ims]/g, ""));
    } catch (err) {
      throw new Error(`bad regex: ${err.message}`);
    }
  }
  const style = {};
  for (const k of STYLE_KEYS) {
    const v = r.style?.[k];
    if (v == null || v === false) continue;
    if (k === "color" || k === "bg") {
      if (!okColor(v)) throw new Error(`${k} must be a CSS colour like #e0a800 or rebeccapurple, got ${JSON.stringify(v)}`);
      style[k] = String(v).trim();
    } else style[k] = true;
  }
  if (!styleCss(style)) throw new Error("a rule needs at least one style (color, bg, bold, italic, underline, strike, dim)");
  const scope = (Array.isArray(r.scope) ? r.scope : r.scope ? [r.scope] : ["**"]).map((s) => String(s).replace(/^\.?\//, ""));
  return {
    id,
    label: String(r.label || (has ? match.literal : match.regex)).slice(0, 80),
    scope,
    match: has
      ? { literal: String(match.literal), ...(match.ignoreCase === false ? { ignoreCase: false } : {}), ...(match.wholeWord ? { wholeWord: true } : {}) }
      : { regex: String(match.regex), ...(match.flags ? { flags: String(match.flags).replace(/[^ims]/g, "") } : {}), ...(Number(match.group) ? { group: Number(match.group) } : {}) },
    style,
    enabled: r.enabled !== false,
  };
}
