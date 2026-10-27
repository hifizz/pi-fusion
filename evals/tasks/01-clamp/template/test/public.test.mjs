import test from "node:test";
import assert from "node:assert/strict";
import { clamp } from "../src/numbers.ts";
test("an in-range value is unchanged", () => assert.equal(clamp(3, 0, 5), 3));
