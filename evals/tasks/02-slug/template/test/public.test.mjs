import test from "node:test";
import assert from "node:assert/strict";
import { toSlug } from "../src/slug.ts";
test("lowercases a word", () => assert.equal(toSlug("HELLO"), "hello"));
