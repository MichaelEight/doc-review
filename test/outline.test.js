import { test } from "node:test";
import assert from "node:assert/strict";
import { outlineOf, headingAt } from "../web/outline.js";

const titles = (o) => o.map((h) => `${h.level}:${h.title}`);

test("markdown headings, atx and underlined, outside code fences", () => {
  const src = [
    "# Wszystkie cztery teksty",
    "",
    "intro",
    "",
    "Star wars **Hiloptum**",
    "----------------------",
    "",
    "### Menu ###",
    "",
    "```",
    "# not a heading, this is code",
    "```",
    "",
    "## Przygody chłopca „Pani Zima”",
    "",
    "- not a heading",
    "",
  ].join("\n");
  const o = outlineOf(src, "md");
  assert.deepEqual(titles(o), [
    "1:Wszystkie cztery teksty",
    "2:Star wars Hiloptum",
    "3:Menu",
    "2:Przygody chłopca „Pani Zima”",
  ]);
  assert.equal(src.slice(o[0].start, o[0].start + 1), "#", "start points at the heading itself");
  assert.equal(o[0].end, o[1].start, "a heading runs up to the next one");
  assert.equal(o.at(-1).end, src.length);
});

test("levels are normalised so the shallowest is 1", () => {
  const o = outlineOf("### deep\n\ntext\n\n#### deeper\n", "md");
  assert.deepEqual(titles(o), ["1:deep", "2:deeper"]);
});

test("latex sectioning, with starred, optional and nested arguments", () => {
  const src = [
    String.raw`\title{The paper}`,
    String.raw`\section{One}`,
    String.raw`% \section{commented out}`,
    String.raw`\subsection*{Two}`,
    String.raw`\section[short]{Three \emph{and} more}`,
    String.raw`\subsubsection{Four {nested} brace}`,
  ].join("\n");
  assert.deepEqual(titles(outlineOf(src, "tex")), [
    "1:The paper",
    "4:One",
    "5:Two",
    "4:Three and more",
    "6:Four {nested} brace",
  ]);
});

test("plain text only takes markers that cannot be prose", () => {
  const chat = [
    "2013-11-15 16:02:59  <CBremu> jaka masz nazwe uzytkownika na skype?",
    "2013-11-15 16:03:48  <Pan_Skeleton> a poco ci to bremu",
    "2013-11-15 16:06:34  <Pan_Skeleton> zadzwon",
  ].join("\n");
  assert.deepEqual(outlineOf(chat, "txt"), [], "a chat log has no structure to find");

  const notes = ["Rozdział 1", "", "treść", "", "Druga część", "===========", ""].join("\n");
  assert.deepEqual(titles(outlineOf(notes, "txt")), ["2:Rozdział 1", "1:Druga część"]);
});

test("a file with no headings gives an empty outline", () => {
  assert.deepEqual(outlineOf("just a paragraph\n\nand another\n", "md"), []);
  assert.deepEqual(outlineOf("", "md"), []);
});

test("headingAt finds the section a position sits in", () => {
  const src = "# One\n\naaa\n\n# Two\n\nbbb\n";
  const o = outlineOf(src, "md");
  assert.equal(headingAt(o, 0).title, "One");
  assert.equal(headingAt(o, src.indexOf("aaa")).title, "One");
  assert.equal(headingAt(o, src.indexOf("bbb")).title, "Two");
});
