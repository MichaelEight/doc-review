---
name: doc-review
description: Review and edit documents (.md, .txt, .tex) with the user through the doc-review web UI, where they leave Google-Docs-style margin comments and press "Send to AI". Use this WHENEVER the user wants to review, comment on, proofread, polish or iterate on a document, paper, notes, README or LaTeX file together; says "open it in the review tool", "let me comment on it", "doc review"; or mentions @file / #tag comments. Requires the doc-review MCP server (review_* tools).
---

# Doc review loop

The user reads the file in a local web page, selects text (or clicks a spot) and comments in the
margin. Nothing reaches you until they press **Send to AI**. You get all the comments together,
make the edits, and answer each comment in its thread.

## Always give the user the link, in the chat, first

`review_wait` blocks for minutes. Anything you write after calling it reaches the user when the
wait is over, which is far too late: until they open the page they cannot comment, so nothing
will ever arrive and you will both sit there waiting. The browser may also not have opened, the
page may be on another machine, and they may simply have lost the tab.

So the order is always: call `review_open`, **write the `url` out in a chat message**, then call
`review_wait`. Never the other way round, and never only in a tool call.

- Write the literal address on a line of its own, for example
  `http://127.0.0.1:4848/?ws=a1b2c3d4e5&t=…`. Not "the link above", not "the UI is live at the
  link", not a bare word linked to it. The address itself, in full, so it can be copied.
- Say in one line what is open (the folder and how many files) and that you are waiting for
  **Send to AI**.
- The `review_wait` timeout result carries the `url` again. If you reach a timeout and have not
  put the link in the chat yet, write it out before waiting again.
- Repeat the address when you report back after `review_finish`, and whenever the user sounds
  like they cannot find the page.

## Loop

1. `review_open(path)`: a folder, or a file (its folder becomes the workspace). It also tries to
   open the page in their browser, which is a convenience, not a substitute for the link.
2. Write the `url` in the chat, as above.
3. `review_wait()` blocks until they press Send. On `{status: "timeout"}` call it again. Don't
   tell the user each time; keep listening quietly.
4. If the result has an `instruction`, the user set it once for the whole round so each comment
   can be a bare label ("todo", "important name", "sounds like AI"). Read it first and apply it to
   every comment; it overrides the default "edit the file" below wherever they conflict (e.g.
   "don't edit, collect to a file" means: leave the commented files alone and write to
   `instruction.target_abs_path`, creating it if `target_exists` is false). A comment that
   explicitly asks for something else still wins for that comment.
5. For every entry in `comments`:
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
6. `review_finish(summary)` with one line about what changed. The UI then shows your diff, and
   the user accepts or reverts each change.
7. `review_wait()` again for the next round. Stop when the user says they're done in chat.

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
`/translate`, `/format`, `/continue`, `/summarize`, `/check`, `/define`, `/consistency`,
`/style` and `/graph`.

`/graph` writes `figures/<name>.py` and `figures/<name>.png` next to the document with
matplotlib, then inserts the image. Ask the user before installing matplotlib if it is missing.

## Display rules

`review_style` sets colouring that changes how a file is **shown**, never what it contains. Use
it whenever the user asks for something like "colour this nick blue", "grey out the text in
`<>`", "give these lines a background" or "dim the timestamps", with or without the `/style`
command. Never edit the document to satisfy such a request.

A rule has a `scope` (workspace-relative globs, so one rule can cover one file, a folder or
everything), a `match` (a `literal`, or a `regex` with an optional capture `group`), and then a
`style` (`color`, `bg`, `bold`, `italic`, `underline`, `strike`, `dim`), an `annotate`, or both.

```
review_style(rules: [{
  label: "nick: xxSLAYERCATxx",
  scope: ["logs/*.txt"],
  match: { literal: "xxSLAYERCATxx" },
  style: { bg: "rgba(250,196,21,.22)", bold: true },
}])
```

- Scope to the file the comment is on unless the user asks wider. `["**"]` is every file.
- Pick colours that work in both the light and the dark theme: a mid-tone `color` and a
  translucent `rgba` `bg`. Never pure black or white, never an opaque background.
- Rules overlap freely; a later rule's declarations win on the text they share.
- `op: "list"` (optionally for one `file`) shows what is set; `op: "clear"` removes rules by
  `ids`, or all of them. Pass an existing `id` in `set` to tune a rule instead of adding another.
- The user can switch any rule off in the sidebar, so say what you added and let them try it.

### Notes on a match

`annotate` attaches a note to every match. `show: "hover"` (the default) puts it in a tooltip,
`show: "inline"` draws it right after the match. A note is decoration: it is never written to the
file, cannot be selected or copied, and shows in the reading view only, because the source view
has to line up with the file character for character.

In `annotate.text`, `$0` is the whole match and `$1`… its capture groups. `{delta}` is the gap
from this rule's previous match, written `+0h 0m 16s`, and needs `annotate.delta` set: each match
is then read as a time (`2013-11-15 16:02:59`, `2013-11-15T16:02`, or a bare `16:02:59`, which
wraps at midnight). `delta.group` reads a capture group instead of the whole match. The first
match has nothing to compare against, so it gets no note.

"How long between these lines?" on a chat log is therefore:

```
review_style(rules: [{
  label: "gap since previous line",
  scope: ["chats/*.txt"],
  match: { regex: "^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}", flags: "m" },
  annotate: { text: "{delta}", show: "inline", delta: {} },
}])
```

Keep notes short: they sit in the middle of the text. A whole sentence belongs in a comment
thread, not in an annotation.

### Recipes

The user can pick a ready-made rule from the UI instead of typing one. It arrives as an ordinary
`/style` comment, with a line like:

```
Apply it to this scope and nothing else: scope ["logs/*", "notes.txt"].
```

That line is the user picking files and folders by hand, so pass those globs to `review_style`
unchanged. Do not widen them, do not narrow them to the file the comment sits on, and do not
make one rule per file when one glob covers them. The comment is anchored in whichever file they
happened to have open, which says nothing about what the rule should cover.

A recipe can be vague ("colour the speakers", "explain each command on hover") because you fill
in the detail: read a file in scope first, work out the real pattern from what is in it, and say
in your reply what you matched.

## Comments made on the PDF

For `.tex` files the user can also comment on the rendered PDF. The anchor (`quote`, `line`) is
the matching LaTeX source. `pdf_quote` is the text as it looked in the PDF; use it when the source
match looks loose, for example on math.

## References inside comments

- `@path/file`: a workspace file, resolved for you in `referenced_files`. Read it when the
  comment refers to it ("make this consistent with @intro.md").
- `#tag`: a workspace concept or convention. Definitions come in `tags`. When a tag is undefined
  and its meaning is clear from context, define it with `review_define_tag` so it autocompletes
  next time.
- Requests like "research this", "add a source", or "format as a table" are ordinary
  instructions: do them with your usual tools, then resolve with what you did.

## Rules

- The url goes in a chat message before the first `review_wait`, written out in full. Without it
  the user cannot reach the page and the wait never ends.
- While a round is open the UI is read-only for the user, so don't leave rounds hanging: always
  `review_finish` when you're done, even if you only asked questions.
- To raise a point yourself (a doubt, a fact to check), use
  `review_comment(file, quote, text)` instead of burying it in chat.
- Never edit `.doc-review/` by hand. It holds the comment store, the display rules and baselines.
