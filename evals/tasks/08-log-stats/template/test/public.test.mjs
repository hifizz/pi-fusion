import test from "node:test";
import assert from "node:assert/strict";
import { analyze } from "../src/analyze.ts";
test("existing analyze output", () => {
  assert.deepEqual(analyze("INFO|api|2\nERROR|db|3\nbad line"), {
    count: 2, totalDuration: 5, errorCount: 1, byService: { api: 1, db: 1 },
  });
});
