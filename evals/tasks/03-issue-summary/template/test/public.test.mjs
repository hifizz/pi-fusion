import test from "node:test";
import assert from "node:assert/strict";
import { buildReport } from "../src/report.ts";
test("empty report", () => {
  assert.equal(buildReport([]), "Issues: 0 (open: 0, closed: 0)\nEstimate: 0\nLabels: -");
});
