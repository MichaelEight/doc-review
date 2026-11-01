# mcp-doc-review

Review documents with an AI the way you would with a colleague in Google Docs. Open a folder,
read a `.md` / `.txt` / `.tex` file in a clean local web page, select text (or click any spot) and
leave margin comments, then press **Send to AI**. The agent that opened the page gets every
comment with its location and context. It edits the files, then answers in each thread
("Corrected", "Yeah, that's right") or asks you a question there. You review its changes as a
diff and accept or revert each one.

- **Server** (`src/`): MCP over stdio, plus a local HTTP UI on `127.0.0.1`. Zero dependencies,
  Node 18+.
- **UI** (`web/`): vanilla JS. Markdown is rendered with source positions so comments anchor to
  exact text. KaTeX for math loads from jsDelivr; without it, math shows as source.
- **Skill** (`.claude/skills/doc-review/SKILL.md`): the review loop for the agent.
- **Data**: `<workspace>/.doc-review/comments.json` (threads, rounds, tags, display rules) and
  `baselines.json` (what the diff compares against). Add `.doc-review/` to the workspace's
  `.gitignore` unless you want to keep the review history.
- **Token**: the UI link carries a secret kept in `~/.config/doc-review/token` (mode 600;
  override with `DOC_REVIEW_TOKEN_FILE`). It survives restarts, so open tabs keep working; delete
  the file to revoke old links.

## Setup

```bash
claude mcp add --scope user doc-review -- node /Users/michaeleight/Coding/MCP/mcp-doc-review/src/server.js
ln -s /Users/michaeleight/Coding/MCP/mcp-doc-review/.claude/skills/doc-review ~/.claude/skills/doc-review
```

LaTeX preview needs `latexmk` or `pdflatex` (MacTeX / BasicTeX: `brew install --cask basictex`,
~100 MB). Without one, the PDF tab is hidden. Comments on the PDF also need `synctex` (it ships with
TeX Live and BasicTeX): it maps a spot in the PDF to its source line, and the selected words are
then matched in that line, so a comment on rendered math lands on the LaTeX that produced it.
The PDF is drawn with PDF.js from jsDelivr.

UI only, no agent (comments queue until an agent calls `review_wait` on the same folder):

```bash
node src/server.js --serve ~/path/to/folder
```

`DOC_REVIEW_PORT` sets the first port to try (default 4848).

## Using it

| Action | How |
|---|---|
| Quick search | ⌘K / Ctrl-K: type to jump to a file by path, or to find a phrase anywhere in the folder. ↑ ↓ to move, ↵ to open, Esc to close. Opening a text hit jumps to that spot and selects it. |
| Jump to a heading | Click the file name in the header, or ⌘⇧O: the document's own structure, indented by level, with the section you are in marked. Click one to jump there. Markdown reads `#` and underlined headings, LaTeX its sectioning commands, plain text only unmistakable markers (an underline, a leading `#`, a line that says "Chapter 3"), so a chat log correctly offers nothing. |
| Display recipes | ☆ above the file list: ready-made colouring and notes. Pick one, tick the files or folders, send (see below). |
| Reading settings | The book button in the header: reading font (serif, sans, mono), size, column width, and whether a line break inside a paragraph reflows as a space. Reflow is on by default, so hard-wrapped Markdown reads as paragraphs; turn it off for poems, addresses and logs, where every break matters. The settings are per browser and persist. |
| Browse files | The sidebar groups files by folder. Click a folder header to fold it; the header shows how many files it holds, plus open comments and a dot for pending AI changes while it is folded. The ⌃⌄ buttons above the list fold or unfold everything, and the state is remembered per folder. |
| Comment on text | Select it, click **Comment** in the margin (or ⌘⌥M) |
| Comment at a spot | Click anywhere in the page, then **+** |
| Reply / answer the AI | Click the card, type, ⌘↵ |
| Bigger conversation | ⤢ on a card opens it as a popup |
| @file, #tag | Type `@` or `#` in a comment to autocomplete |
| Commands | Start a comment with `/` (see below) |
| Send | **Send to AI** (⌘⇧↵) |
| Formatting | ⌘B bold, ⌘I italic, ⌘U underline, ⌘⇧X strikethrough, ⌘E code, ⌘⌥1–3 headings, ⌘⇧8 / ⌘⇧7 lists, Tab / ⇧Tab indent. These work in Edit, and on a selection in Read. ⌘K inserts a link inside the source editor only, since everywhere else it opens quick search. Markdown and LaTeX markup as appropriate. |
| Review AI edits | **Changes** tab: hover a change for Accept / Revert, or Accept all / Revert all |
| LaTeX | **Source** to edit and comment; **PDF** to compile, preview and comment right on the rendered page (select text or click a spot) |

### Commands

Start a comment with `/` to pick a command. The menu shows each command's parameters and
examples. The command applies to the selected text; for a click comment, to the paragraph around
the spot; add `all` (for `/fix`) to cover the whole file.

| Command | What the AI does |
|---|---|
| `/fix [all]` | Fixes grammar, spelling and punctuation only, with minimal changes |
| `/simplify [how]` | Plainer words and shorter sentences, same meaning |
| `/explain [question]` | Explains briefly in the thread; no edit |
| `/rewrite [tone]` | Rephrases in a tone (`formal`, `casual`, …) |
| `/shorten [target]` | Shortens (`50%`, `40 words`, `one sentence`) |
| `/expand [what]` | Adds detail or an example |
| `/translate <language>` | Translates in place |
| `/format <as>` | Converts to `list`, `table`, `latex`, `code`, … |
| `/continue [direction]` | Writes the next part from this point |
| `/summarize [length]` | Inserts a short summary at the comment |
| `/check [what]` | Fact-checks; replies with a verdict and sources |
| `/define [term]` | Proposes a footnote or glossary entry, adds it once you agree |
| `/consistency [@file]` | Makes terms, spelling and tense consistent, optionally against another file |
| `/style <how>` | Sets up colouring or notes for the view: a nick, a pattern, a kind of line, the gap between lines (see below) |
| `/graph [what]` | Plots the data with matplotlib into `figures/` and inserts the image |

Editing is locked while the AI is working (comments still work) and while there are AI changes
waiting for review. This keeps your edits from mixing into the AI's diff.

### Display rules

Colouring and notes that change how a file looks, never what it holds. You ask for it in a
comment, in plain words: *"colour this nick blue"*, *"grey out everything in `<>`"*, *"dim the
timestamps in the whole logs folder"*, *"show me how long passed since the previous line"*. The
AI turns that into rules with `review_style`; the document on disk is untouched.

A rule is a scope, a match, and then a style, a note, or both:

| Part | What |
|---|---|
| `scope` | Workspace-relative globs. `["notes.md"]` one file, `["logs/*.txt"]` a folder, `["chats/**"]` a tree, `["**"]` everything (the default). `*` stays inside one path segment, `**` crosses folders. |
| `match` | A `literal` (with `ignoreCase`, `wholeWord`) or a `regex` (with `flags` of `i`/`m`/`s` and an optional capture `group` to paint only part of the match). |
| `style` | `color`, `bg`, `bold`, `italic`, `underline`, `strike`, `dim`. Colours are plain CSS colours and nothing else. |
| `annotate` | A note on every match. `text` takes `$0` for the match, `$1`… for capture groups, and `{delta}` for the gap since the rule's previous match. `show` is `hover` (a tooltip) or `inline` (drawn after the match). |

`{delta}` needs `annotate.delta`, which reads each match as a time: `2013-11-15 16:02:59`,
`2013-11-15T16:02`, or a bare `16:02:59` that wraps at midnight. It is written the way it reads
out loud, `+0h 0m 16s`, with a day count only when there is one. The first match has nothing to
compare against, so it gets no note.

Notes are decoration. They are never written to the file, cannot be selected or copied, and
appear in the reading view only: the source view's overlay has to line up with the textarea
underneath it character for character, so nothing that is not in the file can be drawn there.

Rules show up in a **Display rules** panel at the bottom of the sidebar, listing the ones that
apply to the open file with a preview of each. The checkbox switches a rule off without deleting
it, so you can ask for a colouring, try it, and turn it off again. They apply in both Read and
Source, and overlapping rules stack with the later one winning.

### Recipes

The ☆ button above the file list opens **Display recipes**: the half-dozen rules people ask for
most, already written out. Pick one, fill in the blanks, tick the files or whole folders it
should cover, edit the wording if you want, and it goes in as an ordinary `/style` comment that
the next round picks up. **Add and send** delivers it straight away.

Folders are ticked as a whole, so a folder whose files are all picked becomes one glob: forty
paths turn into `logs/*`, and the rule keeps working when the folder grows.

Adding a recipe is data, not code. An entry in `RECIPES` in `web/recipes.js`:

```js
{
  id: "time-gap",
  name: "Time since the previous line",
  blurb: "Writes +0h 0m 16s after every timestamp",
  fields: [{ name: "what", label: "What to fade", placeholder: "the timestamps" }],
  prompt: "Add a display rule that dims {{what}}.",
}
```

`{{field}}` is replaced by what the user typed, or by that field's `default`, or by its
`placeholder`. Single braces are left alone, so `{delta}` reaches the AI untouched. The scope
line is appended for you, so a prompt should never say which files to change. A test walks every
recipe and fails if a field is unused, a placeholder survives, or a prompt writes its own scope.

They live in `.doc-review/comments.json` alongside the comment threads, so they persist and are
shared between the UI and the agent. They are per workspace, not per user.

## Tools

| Tool | What |
|---|---|
| `review_open` | Open a folder/file in the UI, return the URL. The agent writes that URL in the chat before it waits: `review_wait` blocks for minutes, so a link sent after it arrives too late to be useful. |
| `review_wait` | Block until the user sends comments (`timeout_seconds`, default 540; returns `{status:"timeout"}`, with the URL again, to re-call). Ends the previous round. |
| `review_reply` | Post in a thread: `kind` `note` or `question`. |
| `review_resolve` | Resolve a thread with a short note. |
| `review_comment` | AI starts a thread on an exact quote. |
| `review_finish` | End the round with a summary; the UI unlocks and shows the diff. |
| `review_threads` | List threads with current positions. |
| `review_style` | Set, list or clear display rules: colouring and notes for how files are shown. |
| `review_define_tag` | Define a `#tag` for the workspace. |

## How anchoring works

A comment stores the quoted text and 32 characters of context on each side, not an offset
(`web/anchor.js`). When a file changes, whether typed in the UI or rewritten by the AI on disk,
the server maps each thread through a line and word diff of the old and new text
(`web/remap.js`), so comments follow their text. A comment whose text is gone shows under
"Text no longer found".

## Tests

```bash
npm test
```
