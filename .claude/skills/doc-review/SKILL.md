---
name: doc-review
description: Review and edit documents (.md, .txt, .tex) with the user through the doc-review web UI, where they leave Google-Docs-style margin comments and press "Send to AI". Use this WHENEVER the user wants to review, comment on, proofread, polish or iterate on a document, paper, notes, README or LaTeX file together; says "open it in the review tool", "let me comment on it", "doc review"; or mentions @file / #tag comments. Requires the doc-review MCP server (review_* tools).
---

# Doc review loop

The user reads the file in a local web page, selects text (or clicks a spot) and comments in the
margin. Nothing reaches you until they press **Send to AI**. You get all the comments together,
make the edits, and answer each comment in its thread.

## Loop

1. `review_open(path)`: a folder, or a file (its folder becomes the workspace). Give the user the
   `url`; it opens in their browser by default.
2. `review_wait()` blocks until they press Send. On `{status: "timeout"}` call it again. Don't
   tell the user each time; keep listening quietly.
3. For every entry in `comments`:
   - Read `quote`, `line`, `context_before`/`context_after` and the whole `messages` thread
     (entries marked `new` are what they just sent). `target: "point"` means "at this spot":
     usually insert something there.
   - Edit the file at `abs_path` directly with your normal file tools. Keep the user's style and
     formatting conventions (Markdown, LaTeX); change only what the comment asks for.
   - Close the thread:
     - done: `review_resolve(id, note)` with a short note ("Corrected", "Rewrote as asked",
       "Added the citation").
     - agree, no change needed: `review_resolve(id, "Yeah, that's right: …")`.
     - need an answer first: `review_reply(id, text, kind: "question")`. Leave the thread open;
       the answer arrives in a later `review_wait`. Don't guess on anything that matters.
     - explaining without closing: `review_reply(id, text)` (kind `note`).
4. `review_finish(summary)` with one line about what changed. The UI then shows your diff, and
   the user accepts or reverts each change.
5. `review_wait()` again for the next round. Stop when the user says they're done in chat.

## Slash commands

A comment can start with a command, such as `/fix`, `/shorten 50%` or `/translate Polish`. The
entry in `comments` then has a `command` object: `name`, `args`, optional `extra` (any lines
after the first) and `instructions`, which say exactly what to do. Follow those instructions and
apply them to the comment's scope: the selection, or the paragraph around a point comment.

What to do depends on `action`:

- `edit`: change the file, then `review_resolve` with what you did.
- `reply`: answer in the thread only (`/explain`, `/check`), without editing the file.
- `confirm`: propose with `kind: "question"` (`/define`), and edit only after the user agrees in
  a later round.

The commands are `/fix`, `/simplify`, `/explain`, `/rewrite`, `/shorten`, `/expand`,
`/translate`, `/format`, `/continue`, `/summarize`, `/check`, `/define`, `/consistency` and
`/graph`.

`/graph` writes `figures/<name>.py` and `figures/<name>.png` next to the document with
matplotlib, then inserts the image. Ask the user before installing matplotlib if it is missing.

## References inside comments

- `@path/file`: a workspace file, resolved for you in `referenced_files`. Read it when the
  comment refers to it ("make this consistent with @intro.md").
- `#tag`: a workspace concept or convention. Definitions come in `tags`. When a tag is undefined
  and its meaning is clear from context, define it with `review_define_tag` so it autocompletes
  next time.
- Requests like "research this", "add a source", or "format as a table" are ordinary
  instructions: do them with your usual tools, then resolve with what you did.

## Rules

- While a round is open the UI is read-only for the user, so don't leave rounds hanging: always
  `review_finish` when you're done, even if you only asked questions.
- To raise a point yourself (a doubt, a fact to check), use
  `review_comment(file, quote, text)` instead of burying it in chat.
- Never edit `.doc-review/` by hand. It holds the comment store and baselines.
