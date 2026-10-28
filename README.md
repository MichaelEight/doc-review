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
- **Data**: `<workspace>/.doc-review/comments.json` (threads, rounds, tags) and
  `baselines.json` (what the diff compares against). Add `.doc-review/` to the workspace's
  `.gitignore` unless you want to keep the review history.

## Setup

```bash
claude mcp add --scope user doc-review -- node /Users/michaeleight/Coding/MCP/mcp-doc-review/src/server.js
ln -s /Users/michaeleight/Coding/MCP/mcp-doc-review/.claude/skills/doc-review ~/.claude/skills/doc-review
```

LaTeX preview needs `latexmk` or `pdflatex` (MacTeX / BasicTeX: `brew install --cask basictex`,
~100 MB). Without one, the PDF tab is hidden.

UI only, no agent (comments queue until an agent calls `review_wait` on the same folder):

```bash
node src/server.js --serve ~/path/to/folder
```

`DOC_REVIEW_PORT` sets the first port to try (default 4848).

## Using it

| Action | How |
|---|---|
| Comment on text | Select it, click the **+** in the margin (or ⌘⌥M) |
| Comment at a spot | Click anywhere in the page, then **+** |
| Reply / answer the AI | Click the card, type, ⌘↵ |
| Bigger conversation | ⤢ on a card opens it as a popup |
| @file, #tag | Type `@` or `#` in a comment to autocomplete |
| Send | **Send to AI** (⌘⇧↵) |
| Formatting | ⌘B bold, ⌘I italic, ⌘U underline, ⌘⇧X strikethrough, ⌘E code, ⌘K link, ⌘⌥1–3 headings, ⌘⇧8 / ⌘⇧7 lists, Tab / ⇧Tab indent. These work in Edit, and on a selection in Read. Markdown and LaTeX markup as appropriate. |
| Review AI edits | **Changes** tab: hover a change for Accept / Revert, or Accept all / Revert all |
| LaTeX | **Source** to edit and comment, **PDF** to compile and preview |

Editing is locked while the AI is working (comments still work) and while there are AI changes
waiting for review. This keeps your edits from mixing into the AI's diff.

## Tools

| Tool | What |
|---|---|
| `review_open` | Open a folder/file in the UI, return the URL. |
| `review_wait` | Block until the user sends comments (`timeout_seconds`, default 540; returns `{status:"timeout"}` to re-call). Ends the previous round. |
| `review_reply` | Post in a thread: `kind` `note` or `question`. |
| `review_resolve` | Resolve a thread with a short note. |
| `review_comment` | AI starts a thread on an exact quote. |
| `review_finish` | End the round with a summary; the UI unlocks and shows the diff. |
| `review_threads` | List threads with current positions. |
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
