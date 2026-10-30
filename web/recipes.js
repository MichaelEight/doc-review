// Ready-made display rules. Each recipe is the words for a job the AI does well but that nobody
// wants to re-type: pick it, say which files, tweak the wording, and it goes in as a comment that
// the normal review round picks up. The AI still writes the actual rule, so a recipe can be vague
// where a hand-written rule would have to be exact.
//
// Adding one is data, not code: drop an entry in RECIPES. `prompt` is the instruction, with
// `{{field}}` replaced by what the user typed (single braces are left alone, so `{delta}` reaches
// the AI untouched). Every prompt is sent with a scope line appended, so none of them should
// mention which files to change.

export const RECIPES = [
  {
    id: "time-gap",
    name: "Time since the previous line",
    blurb: "Writes +0h 0m 16s after every timestamp",
    prompt:
      "Add a display rule that matches the timestamp at the start of each line and annotates it with {delta}, " +
      "shown inline, so each line says how long passed since the line before it.",
  },
  {
    id: "dim-noise",
    name: "Dim the repetitive part",
    blurb: "Fades timestamps and other boilerplate",
    fields: [{ name: "what", label: "What to fade", placeholder: "the timestamps at the start of each line" }],
    prompt: "Add a display rule that dims {{what}}, so the eye goes to the content instead.",
  },
  {
    id: "highlight-term",
    name: "Highlight a word or a name",
    blurb: "Gives one term a colour wherever it appears",
    fields: [
      { name: "term", label: "Word or name", placeholder: "xxSLAYERCATxx" },
      { name: "look", label: "How it should look", placeholder: "yellow background", default: "a translucent yellow background" },
    ],
    prompt: "Add a display rule that gives {{term}} {{look}} everywhere it appears.",
  },
  {
    id: "speakers",
    name: "Colour the speakers",
    blurb: "A colour per nickname, so a conversation reads at a glance",
    prompt:
      "Add display rules that colour the speaker nicknames in these chat logs. Read the file first, pick out the " +
      "nicknames that actually speak, and give each of them its own colour, consistent across every file in scope. " +
      "Keep the colours distinguishable and readable in both the light and the dark theme.",
  },
  {
    id: "label-match",
    name: "Explain something on hover",
    blurb: "A tooltip on each match, written by the AI",
    fields: [
      { name: "what", label: "What to annotate", placeholder: "each command like /tp or /gamemode" },
      { name: "note", label: "What the tooltip should say", placeholder: "what the command does" },
    ],
    prompt: "Add a display rule that matches {{what}} and shows {{note}} in a tooltip on hover.",
  },
  {
    id: "mark-lines",
    name: "Mark a kind of line",
    blurb: "Colours whole lines that match a pattern",
    fields: [
      { name: "which", label: "Which lines", placeholder: "lines in square brackets, the server's own actions" },
      { name: "look", label: "How they should look", placeholder: "purple and italic", default: "a distinct colour" },
    ],
    prompt: "Add a display rule that matches {{which}} and renders the whole line in {{look}}.",
  },
];

export const findRecipe = (id) => RECIPES.find((r) => r.id === id) || null;

// Folders whose every file is picked collapse into one glob, so the AI gets "logs/*.txt" rather
// than forty paths, and the rule keeps working when the folder grows.
export function scopeGlobs(picked, allFiles) {
  const paths = [...picked];
  if (!paths.length) return [];
  const all = allFiles.map((f) => f.path);
  if (paths.length === all.length) return ["**"];
  const dirOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
  const byDir = new Map();
  for (const p of all) {
    const d = dirOf(p);
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d).push(p);
  }
  const out = [];
  const left = new Set(paths);
  for (const [d, files] of byDir) {
    if (!files.every((f) => left.has(f))) continue;
    for (const f of files) left.delete(f);
    out.push(d ? `${d}/*` : "*");
  }
  return [...out, ...left].sort();
}

// One line the AI can pass straight to review_style, plus the plain-words version so a human
// reading the thread later can tell what was asked for.
export function scopeLine(globs) {
  if (!globs.length) return "";
  if (globs.length === 1 && globs[0] === "**") return "Apply it to every file in the workspace: scope [\"**\"].";
  const list = globs.map((g) => `"${g}"`).join(", ");
  return `Apply it to ${globs.length === 1 ? "this scope" : "these scopes"} and nothing else: scope [${list}].`;
}

export function fillPrompt(recipe, values = {}, globs = []) {
  const body = String(recipe.prompt).replace(/\{\{(\w+)\}\}/g, (whole, key) => {
    const f = recipe.fields?.find((x) => x.name === key);
    const v = String(values[key] ?? "").trim() || f?.default || f?.placeholder || "";
    return v;
  });
  const scope = scopeLine(globs);
  return `/style ${body}${scope ? "\n\n" + scope : ""}`;
}
