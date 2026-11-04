# Plan: standalone Doc Review

Status (2026-11-04): phases 1, 2 (partly), 6 (basic) and 7 (built-in AI) are built; see git history.
Not done: npm publish, `.docx` support (phases 4-5), bundled KaTeX/PDF.js, signed installers, manual
Windows testing. The text below is the original plan.

Extract `mcp-doc-review` from the `cc-mcp-skill` monorepo into its own project, so people without
Claude Code or Claude Desktop can use it, including non-technical users such as PhD students.

## Decisions

| Topic | Decision |
|---|---|
| Name | Doc Review, npm package `doc-review`, repo `MichaelEight/doc-review` |
| Non-technical users | Double-click Electron installer for Windows 11 and macOS |
| Developers wanting only MCP | One line pasted in a terminal, using `npx` |
| File formats | `.md`, `.txt`, `.tex`, `.bib`, plus new `.docx` support |
| Licence and price | Free and open source, MIT |
| Privacy | No accounts, no telemetry, no hosted service |
| AI without MCP | "Copy for ChatGPT" first, then a built-in loop using the user's own API key |

Why Electron rather than Tauri: the server is already Node and runs almost unchanged in Electron.
Tauri would still have to ship Node alongside it.

Name availability, last checked 2026-11-04: npm returned no `doc-review` package and the GitHub repo
does not exist. Neither is reserved. Trademarks are unchecked, and npm can still reject a name too
close to an existing one.

## Repo shape

One codebase with two outputs:

- **npm package:** core server and UI. No Electron, no runtime dependencies. Keep it that way.
- **`app/` folder:** Electron wrapper, start screen, built-in AI settings, installer config.

Developer install, once published:

```bash
claude mcp add doc-review -- npx -y doc-review
```

Other MCP clients such as Cursor get a config snippet in the README. The agent skill stays optional,
installed by a second command, since the MCP server's instructions already explain the basic loop.

## Before phase 1

- Commit or drop the uncommitted edits to `src/server.js` and `.claude/skills/doc-review/SKILL.md`,
  so they are not lost in the move. They recommend running the review loop in a background subagent.
  They came from outside the session that wrote this plan, so check with the user. Root `README.md`
  also has uncommitted edits.
- `examples/` is untracked and contains `.doc-review/` state. Decide whether it moves.

## Phases

### 1. Extract

- Move to a new repo keeping history (18 commits), using `git filter-repo` or `git subtree split`.
- Add the missing `LICENSE` file. `package.json` says MIT, but no file exists.
- Keep MCP as a mode of the new project.
- Update local setup, or Claude Code breaks: the MCP registration in `~/.claude.json` and the symlink
  `~/.claude/skills/doc-review` both point at `~/Coding/MCP/mcp-doc-review`.
- Leave a pointer in `cc-mcp-skill`.
- Structure the repo as described above.

**Done when:** the MCP flow and all tests pass from the new repo.

### 2. Portability

- `src/latex.js:13` calls `/usr/bin/which`, which does not exist on Windows.
- `src/tools.js:249` opens the browser only on macOS and Linux.
- KaTeX and PDF.js load from a CDN (`web/index.html`, `web/pdfview.js`). Copy them in at build time,
  not into git.
- Nothing has been tested on Windows, so expect more.
- Test on Windows 11 and on Apple Silicon and Intel Macs. Windows on ARM can wait.

**Done when:** tests and a manual review pass on clean Windows 11 and macOS machines, offline.

### 3. Publish to npm

Ships before the installers because it needs no signing and no start screen, and it puts real users
on the extracted code early. Publishing needs the user's explicit go-ahead.

**Done when:** a developer can install it with one line.

### 4. Word test

The decision point for Word. Before building any UI, make a small prototype that makes one tracked
edit in a `.docx` and writes the file back.

Test on real documents, including a thesis with tables, equations, footnotes, Zotero or EndNote
citations, images and existing tracked changes. Real documents stay out of the public repo unless
their authors agree; commit only made-up samples.

**Done when:** Word on Windows and Mac opens every edited file with no repair prompt, and untouched
parts stay byte-identical. If this fails, rethink the approach before building on it.

### 5. Word build

Edit the original `.docx` directly. Never convert to Markdown and back, because that destroys
formatting, citations and layout. A `.docx` is a zip of XML files, so change only the words needed
and leave everything else alone.

Key design idea: the reading view works from a tree where every piece of text knows its position in
the source (`web/markdown.js`, rendered by `renderTree` in `web/view.js`). If a Word parser produces
that same tree from the document's text, these should work with little change: comment anchoring,
margin cards, highlights, display rules, search and comment jumping.

User experience:

- A `.docx` appears in the file list and opens in Read view. No Source view.
- Comments work as for other files.
- AI edits are saved as real Word tracked changes, accepted or rejected in the app or in Word.
- Optional export of comments into the file as real Word comments.
- The original is copied into `.doc-review/` before the first AI edit, with one-click restore.

Code that has to change:

- `readFile`, `writeFile` and baselines in `src/workspace.js` assume UTF-8 text, and the file type
  list on line 12 is text-only. These need a per-format layer.
- The 2 MB limit (`MAX_EDITABLE_BYTES`) is too small for Word files with images. Apply it to the
  extracted text instead.
- Agents cannot edit `.docx` with file tools, so add MCP tools to read the text and replace a passage.
  The built-in AI uses the same tools. Update `SKILL.md`.
- The Changes view accepts and reverts on text. For Word it must act on tracked changes.
- The outline (`web/outline.js`) must read Word heading styles.
- `kindOf` and the mode list in `web/app.js` need a `docx` kind.

First version scope:

- **Shown and editable:** paragraphs, headings, bold and italic, lists, tables.
- **Shown only, not editable by AI:** images, equations, footnotes, citation fields.
- **Not supported:** old `.doc` files. Show a message asking to save as `.docx`.

**Done when:** comments and AI tracked changes work on `.docx` across the test documents.

### 6. Start screen

- Open folder with a native dialog, drag and drop, recent folders. Today a path comes from the command
  line or an agent.
- Handle port conflicts and closing the app.
- Plain-language errors.

**Done when:** someone goes from opening the app to adding a comment with no instructions.

### 7. AI without MCP

App only, since MCP users already have an agent.

1. **Copy for ChatGPT:** one button copies the comments and instruction as a prompt to paste into any
   chatbot. No key and no API cost. Many people pay for ChatGPT but have no API key, and the two are
   billed separately. Replies are applied by hand at first.
2. **Built-in AI:** a small loop inside the existing server, not a separate API server.
   - On Send, take the same payload `review_wait` returns (`deliver()` in `src/workspace.js`).
   - Call an OpenAI-compatible `/chat/completions` with a configurable base URL, key and model. This
     covers OpenAI, OpenRouter and local Ollama or LM Studio. Built-in `fetch` is enough.
   - Tools: read file, edit file, resolve, reply, finish. Reuse the handlers in `src/tools.js`.
   - Edit tool is strict find-and-replace that fails if the text does not match. No shell, no web.
   - Existing UI then works unchanged: working banner, Changes view, accept and revert.
   - Limits on loop steps and tokens, a Stop button, tokens shown per round.
   - The key goes in the system keychain, never in `.doc-review/`, and is never sent back to the browser.
   - An attached MCP agent takes priority, so there are never two AIs on one round.
   - Share one source of behaviour rules with `SKILL.md`, or they will drift apart.

**Done when:** both routes work, with spending limits enforced.

### 8. Signed installers

- Signed Windows 11 and macOS installers with auto-update, built in GitHub Actions and hosted on
  GitHub Releases.
- A small download page, with a descriptive line such as "comment on documents and let AI handle your
  comments", since the name alone is generic and hard to search for.
- A notices file for bundled libraries (Electron, KaTeX, PDF.js).
- Signing keys stay in protected CI secrets. Builds from outside pull requests must never reach them.
- Optional in-app "Report a problem" link that pre-fills a GitHub issue.

**Done when:** a real non-technical person installs the app and reviews a document while being watched,
with no help. This is the test that matters most.

## Costs

| Item | Cost | Notes |
|---|---|---|
| Apple signing and notarization | $99/year | Hard to avoid. Without it, macOS blocks the app and auto-update generally does not work |
| Windows signing | Possibly free | SignPath offers free signing for open source. Eligibility unchecked. Unsigned shows a SmartScreen warning |
| Hosting and builds | Free | GitHub Releases and GitHub Actions |
| AI | None | Users bring their own key or use Copy for ChatGPT |

## Risks

- **Corrupted Word files:** the worst possible failure for someone's thesis. Hence the backup, the
  byte-identical test, and refusing any edit that cannot be applied safely.
- **Text split across runs:** Word often breaks one sentence into many pieces, sometimes crossing
  citations or links. Replacing such text is the hardest technical part.
- **Existing tracked changes:** the first version shows text with them applied and never alters them.
  AI edits touching them are refused.
- **Word appearance:** Read view looks clean but will not match Word's pages. Exact layout would need
  Word or LibreOffice, too heavy to bundle. Tell users up front.
- **File open in Word:** Windows usually locks it, so saving can fail. Detect this, say "close it in Word
  first", and reload when Word saves new changes.
- **LaTeX size:** PDF view needs LaTeX, a huge install. Show the source view without it. Test Tectonic as
  an optional small add-on, though current code expects `pdflatex` or `latexmk`.
- **Local model quality:** weak models often fail at tool calls or precise edits.
- **Prompt injection:** comments and documents can try to steer the model. Damage is limited to that
  folder, with no shell, and the Changes view can revert it.
- **Support load:** set limits up front. GitHub issues only, best effort, with a bug template.

## Needed from the user

- An Apple Developer account for phase 8, and a SignPath eligibility check.
- A Windows 11 PC, a Mac and Word for testing.
- Real test documents, kept out of the public repo.
- Go-ahead for anything public: creating the repo, reserving or publishing the npm name.

## Not verified

Electron download size (expected 100 MB or more), Tectonic compatibility, and SignPath eligibility.
None of the Word approach has been prototyped.
