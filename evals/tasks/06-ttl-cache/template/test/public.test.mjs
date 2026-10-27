import test from "node:test";
import assert from "node:assert/strict";
import { TTLCache } from "../src/cache.ts";
test("a live entry is readable", () => {
  const cache = new TTLCache(() => 100);
  cache.set("a", "value", 20);
  assert.equal(cache.get("a"), "value");
});
