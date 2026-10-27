import test from "node:test";
import assert from "node:assert/strict";
import { clamp } from "../src/numbers.ts";
test("lower bound", () => assert.equal(clamp(-7, -2, 8), -2));
test("upper bound", () => assert.equal(clamp(11, -2, 8), 8));
test("inclusive and degenerate ranges", () => {
  assert.equal(clamp(2.5, 0, 5), 2.5);
  assert.equal(clamp(99, 4, 4), 4);
  assert.equal(clamp(5, 0, 5), 5);
});
test("invalid inputs", () => {
  assert.throws(() => clamp(2, 4, 1), RangeError);
  for (const args of [[NaN, 0, 1], [0, NaN, 1], [0, 1, NaN]]) {
    assert.throws(() => clamp(...args), RangeError);
  }
});
test("infinity", () => {
  assert.equal(clamp(Infinity, -1, 9), 9);
  assert.equal(clamp(-Infinity, -1, 9), -1);
  assert.equal(clamp(2, -Infinity, Infinity), 2);
});
