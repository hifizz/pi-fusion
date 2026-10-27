import test from "node:test";
import assert from "node:assert/strict";
import { toSlug } from "../src/slug.ts";
test("whitespace", () => assert.equal(toSlug("  Hello \t World\n"), "hello-world"));
test("punctuation and underscores", () => assert.equal(toSlug("a___b///c!!!"), "a-b-c"));
test("accents and decomposed marks", () => {
  assert.equal(toSlug("Café déjà vu"), "cafe-deja-vu");
  assert.equal(toSlug("re\u0301sume\u0301"), "resume");
});
test("empty and non-ASCII-only", () => {
  for (const input of ["", "!!!", "中文", "   "]) assert.equal(toSlug(input), "");
});
test("compatibility normalization and idempotence", () => {
  assert.equal(toSlug("Ｆｏｏ １２"), "foo-12");
  const result = toSlug("-- Version 2.0 --");
  assert.equal(result, "version-2-0");
  assert.equal(toSlug(result), result);
});
