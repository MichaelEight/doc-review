import { test } from "node:test";
import assert from "node:assert/strict";
import { commentOrder, jumpTarget } from "../web/commentnav.js";

const items = [{ id: "c", start: 30 }, { id: "gone", start: null }, { id: "a", start: 10 }, { id: "b", start: 20 }];

test("comments run in document order, with detached ones last", () => {
  assert.deepEqual(commentOrder(items).map((x) => x.id), ["a", "b", "c", "gone"]);
});

test("stepping from a comment moves one along and wraps at both ends", () => {
  assert.equal(jumpTarget(items, "a", 1), "b");
  assert.equal(jumpTarget(items, "b", -1), "a");
  assert.equal(jumpTarget(items, "gone", 1), "a");
  assert.equal(jumpTarget(items, "a", -1), "gone");
});

test("with nothing active the step starts from the view", () => {
  assert.equal(jumpTarget(items, null, 1, 15), "b");
  assert.equal(jumpTarget(items, null, -1, 15), "a");
  assert.equal(jumpTarget(items, "draft", 1, 25), "c");
  // Past the last comment going forward, before the first going back: wrap.
  assert.equal(jumpTarget(items, null, 1, 99), "a");
  assert.equal(jumpTarget(items, null, -1, 0), "gone");
  assert.equal(jumpTarget([], null, 1), null);
});
