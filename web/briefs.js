// Standing instructions ("briefs"): one instruction the user sets once and every comment they send
// carries, e.g. "save what I mark to a file, don't edit". The built-ins below are starting points;
// the user's own presets live in comments.json next to the threads.

export const BRIEF_PRESETS = [
  {
    id: "collect",
    name: "Collect, don't edit",
    target: "review-notes.md",
    text:
      "Do not change the documents I commented on. For each comment, add an entry to the target file: the quoted text " +
      "(or the line it points at), the source file and line, and my comment as its label (e.g. \"todo\", \"important name\", " +
      "\"sounds like AI\"). Group entries under one heading per label, keep what is already in the file and do not add an " +
      "entry twice. Then resolve each comment with a short note such as \"Saved\".",
  },
  {
    id: "answer",
    name: "Answer only",
    text:
      "Do not edit any file. Answer each comment in its thread with review_reply kind=note, briefly, and leave the thread " +
      "open for me to resolve.",
  },
  {
    id: "suggest",
    name: "Suggest, then wait",
    text:
      "Do not edit yet. For each comment, propose the exact change in its thread with review_reply kind=question. Edit only " +
      "what I approve in a later round.",
  },
  {
    id: "light",
    name: "Light touch",
    text:
      "Keep every change minimal: do only what each comment asks, do not rephrase anything around it, and keep my voice " +
      "and terminology.",
  },
];

const MAX_TEXT = 4000;

// Trimmed { text, target } or null when there is nothing to send. target is a workspace-relative path.
export function normalizeBrief(b) {
  const text = String(b?.text ?? "").trim().slice(0, MAX_TEXT);
  const target = String(b?.target ?? "").trim().replace(/^\.?\/+/, "");
  if (!text && !target) return null;
  return { text, ...(target ? { target } : {}) };
}

// A short label for the header: the preset's name when the text is one, otherwise its first words.
export function briefLabel(brief, presets = []) {
  if (!brief) return "";
  const p = [...BRIEF_PRESETS, ...presets].find((x) => x.text === brief.text);
  if (p) return p.name;
  const words = brief.text.split(/\s+/).slice(0, 5).join(" ");
  return words.length < brief.text.length ? words + "…" : words || `Save to ${brief.target}`;
}
