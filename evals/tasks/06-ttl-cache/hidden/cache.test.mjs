import test from "node:test";
import assert from "node:assert/strict";
import { TTLCache } from "../src/cache.ts";
function clock() {
  let now = 0;
  return { cache: new TTLCache(() => now), advance: (ms) => { now += ms; } };
}
test("expiration at the exact boundary", () => {
  const { cache, advance } = clock();
  cache.set("a", 1, 10); advance(10);
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.has("a"), false);
});
test("zero TTL", () => {
  const { cache } = clock();
  cache.set("a", 1, 0);
  assert.equal(cache.has("a"), false);
  assert.equal(cache.size(), 0);
});
test("replacement resets TTL from replacement time", () => {
  const { cache, advance } = clock();
  cache.set("a", "old", 10); advance(8); cache.set("a", "new", 20); advance(4);
  assert.equal(cache.get("a"), "new");
  advance(16);
  assert.equal(cache.has("a"), false);
});
test("undefined is a legitimate stored value", () => {
  const { cache, advance } = clock();
  cache.set("a", undefined, 10);
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.has("a"), true);
  advance(10);
  assert.equal(cache.has("a"), false);
});
test("size prunes expired entries without prior get", () => {
  const { cache, advance } = clock();
  cache.set("a", 1, 5); cache.set("b", 2, 10); advance(5);
  assert.equal(cache.size(), 1);
  advance(5);
  assert.equal(cache.size(), 0);
});
test("invalid TTL does not overwrite an existing value", () => {
  const { cache } = clock();
  cache.set("a", 7, 10);
  for (const ttl of [-1, NaN, Infinity]) assert.throws(() => cache.set("a", 9, ttl), RangeError);
  assert.equal(cache.get("a"), 7);
});
test("expired keys can be set again", () => {
  const { cache, advance } = clock();
  cache.set("a", "old", 1); advance(3); cache.set("a", "new", 10);
  assert.equal(cache.get("a"), "new");
  assert.equal(cache.size(), 1);
});
