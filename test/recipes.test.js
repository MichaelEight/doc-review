import { test } from "node:test";
import assert from "node:assert/strict";
import { RECIPES, findRecipe, fillPrompt, scopeGlobs, scopeLine } from "../web/recipes.js";

const files = [
  { path: "README.md" },
  { path: "notes.txt" },
  { path: "logs/a.txt" },
  { path: "logs/b.txt" },
  { path: "logs/c.txt" },
];

test("a whole folder collapses into one glob", () => {
  assert.deepEqual(scopeGlobs(["logs/a.txt", "logs/b.txt", "logs/c.txt"], files), ["logs/*"]);
  // One file short of the folder, so the paths stay.
  assert.deepEqual(scopeGlobs(["logs/a.txt", "logs/b.txt"], files), ["logs/a.txt", "logs/b.txt"]);
  // A full folder plus a loose file: the folder still collapses.
  assert.deepEqual(scopeGlobs(["logs/a.txt", "logs/b.txt", "logs/c.txt", "notes.txt"], files), ["logs/*", "notes.txt"]);
  assert.deepEqual(scopeGlobs(files.map((f) => f.path), files), ["**"], "everything is **");
  assert.deepEqual(scopeGlobs([], files), []);
});

test("the scope line is something the AI can pass straight through", () => {
  assert.match(scopeLine(["**"]), /every file in the workspace/);
  assert.equal(scopeLine(["logs/*"]), 'Apply it to this scope and nothing else: scope ["logs/*"].');
  assert.equal(scopeLine(["logs/*", "notes.txt"]), 'Apply it to these scopes and nothing else: scope ["logs/*", "notes.txt"].');
  assert.equal(scopeLine([]), "");
});

test("fields fill the prompt and fall back to their default", () => {
  const r = findRecipe("highlight-term");
  const got = fillPrompt(r, { term: "CBremu" }, ["logs/*"]);
  assert.ok(got.startsWith("/style "), "it goes in as a slash command");
  assert.match(got, /gives CBremu a translucent yellow background/, "the empty field used its default");
  assert.match(got, /scope \["logs\/\*"\]/);
});

test("a single-brace placeholder is left for the AI", () => {
  const got = fillPrompt(findRecipe("time-gap"), {}, []);
  assert.match(got, /\{delta\}/, "{delta} is the rule syntax, not a recipe field");
  assert.ok(!got.includes("Apply it to"), "no files picked means no scope line");
});

test("every recipe is complete and its fields are all used", () => {
  const ids = new Set();
  for (const r of RECIPES) {
    assert.ok(r.id && r.name && r.blurb && r.prompt, r.id);
    assert.ok(!ids.has(r.id), `duplicate id ${r.id}`);
    ids.add(r.id);
    for (const f of r.fields || []) {
      assert.ok(f.name && f.label, `${r.id}: a field needs a name and a label`);
      assert.ok(r.prompt.includes(`{{${f.name}}}`), `${r.id}: field ${f.name} is never used`);
    }
    // Nothing left unfilled once the defaults kick in.
    assert.ok(!fillPrompt(r, {}, ["**"]).includes("{{"), `${r.id}: a placeholder survived`);
    assert.ok(!/\bthis file\b|\bthese files\b/i.test(r.prompt), `${r.id}: scope is appended, not written into the prompt`);
  }
});
