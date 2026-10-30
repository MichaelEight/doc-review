// Display rules: colouring and annotation that live next to the document, never inside it. A rule
// says which files it applies to (globs), what to match (a literal or a regular expression), how
// to paint it and what note to attach to it. The AI writes them through review_style; the UI turns
// them into marks that the reading view draws underneath the comment highlights.
//
// A note shows on hover, or inline right after the match. Inline notes are drawn in the reading
// view only: the source view's backdrop has to line up character for character with the textarea
// underneath it, so nothing that is not in the file can be inserted there.
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

// ---------- annotations ----------

// "2013-11-15 16:02:59", "16:02:59", "2013-11-15T16:02". Returns seconds, and whether the stamp
// carried a date: a time-only stamp wraps at midnight, so a negative gap means the next day.
export function parseStamp(s) {
  const m = /(?:(\d{4})-(\d{2})-(\d{2})[T ])?(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(s ?? ""));
  if (!m) return null;
  const hms = Number(m[4]) * 3600 + Number(m[5]) * 60 + Number(m[6] || 0);
  if (!m[1]) return { t: hms, dayless: true };
  return { t: Date.UTC(+m[1], +m[2] - 1, +m[3]) / 1000 + hms, dayless: false };
}

export function formatDelta(sec) {
  const n = Math.abs(Math.round(sec));
  const d = Math.floor(n / 86400);
  const h = Math.floor((n % 86400) / 3600);
  const m = Math.floor((n % 3600) / 60);
  return `${sec < 0 ? "-" : "+"}${d ? d + "d " : ""}${h}h ${m}m ${n % 60}s`;
}

// `$0`..`$9` are the match and its capture groups, `{delta}` the gap from the rule's previous
// match. A template that asks for a delta it cannot have (the first match, an unparsable stamp)
// produces no note at all, rather than a dangling "+".
function noteText(tpl, m, delta) {
  if (tpl.includes("{delta}") && delta == null) return null;
  return tpl
    .replace(/\{delta\}/g, delta == null ? "" : formatDelta(delta))
    .replace(/\$(\d)/g, (_, d) => m[Number(d)] ?? "");
}

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

// Marks to draw in `text`, in rule order: a range, the CSS of its rule, and optionally a note and
// where to show it. Overlaps are kept: a segment covered by several rules gets all of their
// declarations, so the later rule wins.
export function ruleRanges(text, rules) {
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
    const ann = r.annotate || null;
    if (!css && !ann) continue;
    const group = Number(r.match.group) || 0;
    let prev = null;
    let n = 0;
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(text))) {
      const span = m.indices?.[group] ?? (m[group] == null ? null : [m.index, m.index + m[group].length]);
      if (span && span[1] > span[0]) {
        let note = null;
        if (ann) {
          let delta = null;
          if (ann.delta) {
            const now = parseStamp(m[ann.delta.group] ?? m[0]);
            if (now) {
              if (prev) {
                delta = now.t - prev.t;
                // A time-only stamp that went backwards crossed midnight.
                if (delta < 0 && now.dayless) delta += 86400;
              }
              prev = now;
            }
          }
          note = noteText(ann.text, m, delta);
        }
        out.push({ id: r.id, start: span[0], end: span[1], css, note, show: note ? ann.show : null });
      }
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
  const annotate = normalizeAnnotate(r.annotate);
  if (!styleCss(style) && !annotate) {
    throw new Error("a rule needs a style (color, bg, bold, italic, underline, strike, dim) or an annotate");
  }
  const scope = (Array.isArray(r.scope) ? r.scope : r.scope ? [r.scope] : ["**"]).map((s) => String(s).replace(/^\.?\//, ""));
  return {
    id,
    label: String(r.label || (has ? match.literal : match.regex)).slice(0, 80),
    scope,
    match: has
      ? { literal: String(match.literal), ...(match.ignoreCase === false ? { ignoreCase: false } : {}), ...(match.wholeWord ? { wholeWord: true } : {}) }
      : { regex: String(match.regex), ...(match.flags ? { flags: String(match.flags).replace(/[^ims]/g, "") } : {}), ...(Number(match.group) ? { group: Number(match.group) } : {}) },
    style,
    ...(annotate ? { annotate } : {}),
    enabled: r.enabled !== false,
  };
}

function normalizeAnnotate(a) {
  if (!a) return null;
  const text = String(a.text ?? "").trim().slice(0, 200);
  if (!text) throw new Error("annotate needs text");
  const delta = a.delta ? { group: Number(a.delta.group ?? a.delta) || 0 } : null;
  if (text.includes("{delta}") && !delta) throw new Error('annotate.text uses {delta}, so set annotate.delta');
  return { text, show: a.show === "inline" ? "inline" : "hover", ...(delta ? { delta } : {}) };
}
