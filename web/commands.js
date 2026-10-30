// Slash commands: a comment that starts with "/name args" asks for a predefined action. The same
// table drives the UI (autocomplete, parameter help, chips) and what the agent receives in
// review_wait (the command plus concrete instructions for the scope the user picked).
//
// action: "edit"    change the file, then resolve
//         "reply"   answer in the thread, leave the file alone
//         "confirm" propose in the thread (kind=question), edit only after the user agrees

const SCOPE =
  "Scope: the selected text; for a point comment, the paragraph (or list/table block) the point is in; " +
  'with "all" in the arguments, the whole file.';

export const COMMANDS = [
  {
    name: "fix",
    args: "[all]",
    summary: "Fix grammar, spelling and punctuation only",
    action: "edit",
    params: [{ name: "all", optional: true, desc: "Fix the whole file instead of the selection." }],
    examples: ["/fix", "/fix all"],
    instructions:
      "Correct grammar, spelling, punctuation and obvious typos with the smallest possible change. Do not rephrase, restyle " +
      "or change meaning, terminology or formatting. " + SCOPE + " Resolve with a short list of what was corrected, or " +
      '"No errors found".',
  },
  {
    name: "simplify",
    args: "[how]",
    summary: "Plainer words, shorter sentences, same meaning",
    action: "edit",
    params: [{ name: "how", optional: true, desc: "What to simplify or for whom, e.g. \"for a 12-year-old\", \"less jargon\"." }],
    examples: ["/simplify", "/simplify for non-experts"],
    instructions:
      "Rewrite the text so it is simpler to read: plainer words, shorter sentences, less nesting. Keep every fact and the " +
      "author's voice; follow the arguments if given. " + SCOPE,
  },
  {
    name: "explain",
    args: "[question]",
    summary: "Explain the selected part, briefly and simply",
    action: "reply",
    params: [{ name: "question", optional: true, desc: "What exactly to explain, e.g. \"why does this follow?\", \"the second term\"." }],
    examples: ["/explain", "/explain the formula"],
    instructions:
      "Explain the selected text (or the arguments' question about it) in the thread: simple words, 2-5 sentences, an " +
      "example if it helps. Do not edit the file. Reply with review_reply kind=note and leave the thread open.",
  },
  {
    name: "rewrite",
    args: "[tone]",
    summary: "Rephrase with the same meaning",
    action: "edit",
    params: [{ name: "tone", optional: true, desc: "Target tone or style, e.g. formal, casual, academic, \"like a children's book\"." }],
    examples: ["/rewrite formal", "/rewrite punchier"],
    instructions:
      "Rephrase the text in the requested tone or style (if none is given, make it read better). Keep the meaning and every " +
      "fact; keep surrounding formatting. " + SCOPE,
  },
  {
    name: "shorten",
    args: "[target]",
    summary: "Make it shorter",
    action: "edit",
    params: [{ name: "target", optional: true, desc: "How short: a percentage (50%), a word count (40 words) or \"one sentence\"." }],
    examples: ["/shorten", "/shorten 50%", "/shorten one sentence"],
    instructions:
      "Shorten the text to the target (default: about 30-40% shorter). Keep the key points; cut repetition and filler first. " +
      SCOPE + " Resolve with the before/after length.",
  },
  {
    name: "expand",
    args: "[what]",
    summary: "Add detail, examples or explanation",
    action: "edit",
    params: [{ name: "what", optional: true, desc: "What to add, e.g. \"an example\", \"the reasoning\", \"two more sentences\"." }],
    examples: ["/expand", "/expand add an example"],
    instructions:
      "Expand the text with what the arguments ask for (default: the detail a reader would miss). Match the voice and keep it " +
      "tight; do not pad. " + SCOPE,
  },
  {
    name: "translate",
    args: "<language>",
    summary: "Translate in place",
    action: "edit",
    params: [{ name: "language", desc: "Target language, e.g. Polish, German, \"British English\"." }],
    examples: ["/translate Polish", "/translate English"],
    instructions:
      "Translate the text into the language given in the arguments, in place. Keep formatting, math, code, links and proper " +
      "names intact; translate naturally, not word for word. If no language is given, ask with kind=question. " + SCOPE,
  },
  {
    name: "format",
    args: "<as>",
    summary: "Change the structure: list, table, LaTeX, code…",
    action: "edit",
    params: [{ name: "as", desc: "Target structure: list, numbered list, table, latex (math), code, quote, heading." }],
    examples: ["/format table", "/format latex", "/format list"],
    instructions:
      "Convert the text into the structure given in the arguments using the file's own syntax (Markdown or LaTeX): e.g. a " +
      "paragraph into a table, inline math into proper LaTeX, steps into a numbered list. Keep all content. If the target is " +
      "missing or does not fit, ask with kind=question. " + SCOPE,
  },
  {
    name: "continue",
    args: "[direction]",
    summary: "Write what comes next from this point",
    action: "edit",
    params: [{ name: "direction", optional: true, desc: "Where to take it, e.g. \"one more stanza about winter\", \"conclude the section\"." }],
    examples: ["/continue", "/continue a stanza about winter"],
    instructions:
      "Write the next part of the document and insert it right after the comment's position (after the selection if text is " +
      "selected). Match length, voice, form and formatting of the surrounding text (meter and rhyme for verse). Follow the " +
      "direction if given; default to about one paragraph or stanza.",
  },
  {
    name: "summarize",
    args: "[length]",
    summary: "Insert a short summary here",
    action: "edit",
    params: [{ name: "length", optional: true, desc: "Length or form, e.g. \"one sentence\", \"3 bullets\", \"TL;DR\"." }],
    examples: ["/summarize", "/summarize 3 bullets"],
    instructions:
      "Write a short summary and insert it at the comment's position. With selected text, summarize the selection and put the " +
      "summary right before it. With a point comment, summarize the section the point is in (the whole document if the point " +
      "is before the first heading or at the very top). Default length: 1-3 sentences.",
  },
  {
    name: "check",
    args: "[what]",
    summary: "Fact-check: verdict and source",
    action: "reply",
    params: [{ name: "what", optional: true, desc: "Which claim to check, if the selection holds more than one." }],
    examples: ["/check", "/check the date"],
    instructions:
      "Fact-check the claim(s) in the selected text. Research with your tools (web search when available). Reply with kind=note: " +
      "start with a verdict (Correct / Incorrect / Partly correct / Can't verify), then one or two sentences and the source(s) " +
      "as links. Do not edit the file. If it is wrong, end the reply with the corrected wording and ask (kind=question) " +
      "whether to apply it.",
  },
  {
    name: "define",
    args: "[term]",
    summary: "Add a footnote or glossary entry (asks first)",
    action: "confirm",
    params: [{ name: "term", optional: true, desc: "The term to define, if not the whole selection. Add \"glossary\" to put it in a glossary section." }],
    examples: ["/define", "/define latency glossary"],
    instructions:
      "Draft a one- or two-sentence definition of the term (the selection unless the arguments name one). Propose it with " +
      "kind=question, saying where it will go: a footnote by default (Markdown [^term] / LaTeX \\footnote{}), or an entry in a " +
      "Glossary section if asked or if the document already has one. Insert it only after the user agrees in a later round.",
  },
  {
    name: "consistency",
    args: "[@file]",
    summary: "Make terms, spelling and tense consistent",
    action: "edit",
    params: [{ name: "@file", optional: true, desc: "Another file to match (its terms and conventions win). Without it, the file's majority usage wins." }],
    examples: ["/consistency", "/consistency @intro.md"],
    instructions:
      "Make the whole file consistent: terminology, capitalization, spelling variant (US/UK), hyphenation, tense, number and " +
      "unit style, heading style. If the arguments reference a file, match that file's conventions; otherwise use the " +
      "majority usage in this file. Do not change meaning. Resolve with a short list of the conventions you settled on.",
  },
  {
    name: "style",
    args: "<how>",
    summary: "Colour something in the view, without touching the file",
    action: "reply",
    params: [{ name: "how", desc: "What to colour and how, e.g. \"this nick blue\", \"text in <> grey\", \"dim the timestamps\". Add \"here\" for this file only, \"everywhere\" for the whole folder." }],
    examples: ["/style this nick blue", "/style text in <> grey, this file only", "/style dim the timestamps everywhere"],
    instructions:
      "Set up display rules with review_style. These change only how the file is SHOWN; never edit the document for this. " +
      "Work out what to match from the selected text and the arguments: a literal for a name or word, a regex for a pattern " +
      "(e.g. \"<[^>]+>\" for text in angle brackets, a date at the start of a line for timestamps). Scope: this file alone " +
      "unless the user asks wider; use a glob like \"logs/*.txt\" for a folder, [\"**\"] for everything. Pick colours that " +
      "stay readable in both the light and the dark theme: a translucent background (rgba) and a mid-tone colour, never pure " +
      "black or white. Reply with kind=note listing each rule you added (what it matches, where it applies) and mention that " +
      "the rules can be switched off in the sidebar. Do not resolve the thread if the user may want to tune the colours.",
  },
  {
    name: "graph",
    args: "[what]",
    summary: "Plot data as a chart and insert the image",
    action: "edit",
    params: [{ name: "what", optional: true, desc: "What to plot and how, e.g. \"bar chart of revenue by year\", \"log y axis\". Data comes from the selection unless given here." }],
    examples: ["/graph", "/graph line chart, years on x"],
    instructions:
      "Make a chart from the data in the selection (a table, list or numbers) or described in the arguments. If the data or the " +
      "chart type is unclear, ask with kind=question before plotting. Write a small Python script with matplotlib and save both " +
      "the script and the image in a figures/ folder next to the document (figures/<short-name>.py and .png, 150 dpi, white " +
      "background, labelled axes, readable fonts). Check matplotlib is installed (python3 -c \"import matplotlib\"); if it is " +
      "not, ask the user before installing anything. Insert the image after the selection: Markdown ![caption](figures/x.png), " +
      "LaTeX a figure environment with \\includegraphics[width=\\linewidth]{figures/x.png} and \\caption (make sure graphicx is " +
      "loaded), plain text a line with the image path. Resolve with the image path and how to regenerate it.",
  },
];

const BY_NAME = new Map(COMMANDS.map((c) => [c.name, c]));

export const ACTION_LABEL = { edit: "Edits the text", reply: "Answers in the thread", confirm: "Asks before editing" };

export function findCommand(name) {
  return BY_NAME.get(String(name).toLowerCase()) || null;
}

// "/shorten 50%" -> { name: "shorten", args: "50%", def }. Only at the very start of a message.
export function parseCommand(text) {
  const m = /^\/([a-z][\w-]*)(?:[ \t]+([^\n]*))?(?:\n|$)/i.exec(String(text || "").trimStart());
  if (!m) return null;
  const def = findCommand(m[1]);
  if (!def) return null;
  const rest = String(text).trimStart().slice(m[0].length).trim();
  return { name: def.name, args: (m[2] || "").trim(), note: rest, def };
}
