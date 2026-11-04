# Doc Review

Comment on your documents the way you do in Google Docs, then let an AI handle your comments.
Open a folder, read a `.md` / `.txt` / `.tex` file in a clean page, select text, leave a margin comment,
press **Send to AI**. The AI edits the files and answers in each thread; you review its changes as a
diff and accept or revert each one.

Free, open source (MIT). No account, no telemetry, nothing is uploaded except what you send to the AI
provider you choose. Your files stay on your computer.

## Two ways to use it

| | Who it is for | AI |
|---|---|---|
| **Desktop app** | Anyone. Download, double-click, done. | You connect your own: an API key, or a free model running on your computer |
| **MCP server** | Claude Code, Claude Desktop, Cursor and other MCP clients | The AI you already use in that tool |

## Desktop app (no technical knowledge needed)

1. Go to the [Releases page](https://github.com/MichaelEight/doc-review/releases/latest) and download
   `Doc Review` for your computer: the `.dmg` for Mac, the `.exe` for Windows.
2. Install it. The app is not signed yet, so your computer will warn you once:
   - **Mac:** open the `.dmg`, drag Doc Review to Applications, then **right-click it, choose Open**, and
     click Open again.
   - **Windows:** if "Windows protected your PC" appears, click **More info**, then **Run anyway**.
3. Open it, choose the folder with your documents.
4. Click **AI not set up** (top right), pick a provider, paste your key, press **Test connection**.

Where to get an AI key: [OpenAI](https://platform.openai.com/api-keys),
[Anthropic](https://console.anthropic.com/settings/keys) or [OpenRouter](https://openrouter.ai/keys).
A ChatGPT or Claude *chat subscription* is not an API key; the API is billed separately, by use. Free
option: install [Ollama](https://ollama.com), pick "Ollama" in the settings. Quality depends on the model.

The AI can read and edit only files in the folder you opened, and only with exact find-and-replace edits.
It cannot run programs or browse the web. Every change shows up in the **Changes** view, where you can
revert it. Settings include a per-round spending limit, and the pill has a Stop button while it works.

## MCP server (Claude Code, Cursor, others)

Needs [Node.js](https://nodejs.org) 18+ and git. Download once, then register it (two lines):

```bash
git clone https://github.com/MichaelEight/doc-review.git ~/doc-review
claude mcp add --scope user doc-review -- node ~/doc-review/bin/doc-review.js --mcp
```

No git? Download the ZIP from the green **Code** button, unzip it, and use that folder's path instead of
`~/doc-review`. Update later with `git -C ~/doc-review pull`.

Other MCP clients: add this to their config (use the full path, not `~`).

```json
{ "mcpServers": { "doc-review": { "command": "node", "args": ["/full/path/to/doc-review/bin/doc-review.js", "--mcp"] } } }
```

Optional skill (teaches Claude Code the review loop; the server's own instructions already cover the basics):

```bash
ln -s ~/doc-review/.claude/skills/doc-review ~/.claude/skills/doc-review
```

Then ask your AI: "open this folder in doc-review". The AI gets a link; you comment; **Send to AI** delivers
the comments to it. When an MCP agent has a folder open, it takes priority over the built-in AI.

## Run from a terminal (no desktop app)

```bash
node ~/doc-review/bin/doc-review.js ~/path/to/folder          # standalone, with the built-in AI
node ~/doc-review/bin/doc-review.js --serve ~/path/to/folder  # UI only; comments wait for an MCP agent
```

`DOC_REVIEW_PORT` sets the first port to try (default 4848).

## Known limits

- **Not signed yet.** Hence the one-time warning on install. Signing needs a paid Apple developer account
  and a Windows certificate; planned.
- **API key is stored in plain text** in `~/.config/doc-review/ai.json` (readable only by you), not in the
  system keychain. It is never sent to the browser page or written into your documents' folder.
- **Works offline** except for the AI call itself: KaTeX and PDF.js are bundled in `web/vendor/` (see `THIRD-PARTY-NOTICES.md`).
- **Word files (`.docx`) are not supported yet.** See [PLAN-standalone.md](PLAN-standalone.md).
- **LaTeX preview** needs `latexmk` or `pdflatex` installed (MacTeX / BasicTeX / MiKTeX). Without it the
  PDF tab is hidden; commenting on the source works.
- **Tested on macOS.** Windows and Linux are covered by automated tests in CI but have had no manual testing.

## How it works

- **Server** (`src/`): MCP over stdio, plus a local HTTP UI on `127.0.0.1`. Zero runtime dependencies,
  Node 18+. `src/ai.js` is the built-in AI: it waits for **Send** like an MCP agent would, then runs a
  tool-calling loop against any OpenAI-compatible `/chat/completions` endpoint.
- **UI** (`web/`): vanilla JS. Markdown is rendered with source positions so comments anchor to exact text.
- **Desktop app** (`app/`): a thin Electron window around the same server, plus a native folder picker.
  Build locally with `npm install && npm run dist`; releases are built by GitHub Actions on `v*` tags.
- **Skill** (`.claude/skills/doc-review/SKILL.md`): the review loop for MCP agents.
- **Data**: `<folder>/.doc-review/comments.json` (threads, rounds, tags, display rules) and `baselines.json`
  (what the diff compares against). Add `.doc-review/` to the folder's `.gitignore` unless you want to keep
  the review history.
- **Token**: the UI link carries a secret kept in `~/.config/doc-review/token` (mode 600; override with
  `DOC_REVIEW_TOKEN_FILE`). Delete the file to revoke old links.

## Using it

| Action | How |
|---|---|
| Quick search | ⌘K / Ctrl-K: type to jump to a file by path, or to find a phrase anywhere in the folder. ↑ ↓ to move, ↵ to open, Esc to close. Opening a text hit jumps to that spot and selects it. |
| Jump to a heading | Click the file name in the header, or ⌘⇧O: the document's own structure, indented by level, with the section you are in marked. Click one to jump there. Markdown reads `#` and underlined headings, LaTeX its sectioning commands, plain text only unmistakable markers (an underline, a leading `#`, a line that says "Chapter 3"), so a chat log correctly offers nothing. |
| Previous / next comment | The arrows at the bottom right, or ⌥, and ⌥.: step through the open file's comments in document order, resolved or not, wrapping at the ends. The control is fixed in place and keeps its width, so you can keep clicking without moving the mouse. With no comment selected, the step starts from where you are reading. |
| Tabs | Every file you open gets a tab above the page, so switching back is one click. ⌥1–9 jumps to a tab, ⌥[ / ⌥] steps left and right, ⌥W closes the current one (so does a middle-click). Drag a tab to reorder. Tabs are kept per folder in this browser. |
| Pin, favourite, colour | Hover a file in the list for the heart (favourite) and pin, or right-click it (or press ⋯) for a colour mark. Pinned files sit in their own section above every folder; the heart button above the list shows only favourites; a colour tints the row and marks its tab. Kept in this browser only, not in the review. |
| Instruction | The bookmark pill next to Send sets one instruction that goes with every comment in this folder, so each comment can be a bare label ("todo", "important name", "sounds like AI") instead of repeating the request. Pick a preset (*Collect, don't edit*, *Answer only*, *Suggest, then wait*, *Light touch*), write your own, save it as a preset, and optionally name a target file the AI should write to. It stays on until you clear it; while it is on, Send shows it and asks first, with *Send without it* for a one-off. Saved in `.doc-review/`, and each round records which instruction it went with. |
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
| `review_wait` | Block until the user sends comments (`timeout_seconds`, default 540; returns `{status:"timeout"}`, with the URL again, to re-call). Ends the previous round. When the user set a standing instruction, the result carries `instruction` (`text`, and `target_file` / `target_abs_path` / `target_exists` when they named a file), which overrides the default of editing the files. |
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
