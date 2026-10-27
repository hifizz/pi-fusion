import test from "node:test";
import assert from "node:assert/strict";
import { retry } from "../src/retry.ts";
test("one successful attempt", async () => assert.equal(await retry(async () => 5, { attempts: 1 }), 5));
