import test from "node:test";
import assert from "node:assert/strict";
import { filterIssues } from "../src/filter.ts";
import { summarizeIssues } from "../src/summary.ts";
import { buildReport, renderSummary } from "../src/report.ts";
const issues = [
  { id: "a", status: "open", labels: [" Bug ", "BUG", " api "], estimate: 2 },
  { id: "b", status: "closed", labels: ["bug", "UI"], estimate: 3.5 },
  { id: "c", status: "open", labels: ["debug", ""], estimate: 0 },
];
test("status and normalized exact label filter", () => {
  assert.deepEqual(filterIssues(issues, { label: " BuG " }).map((issue) => issue.id), ["a", "b"]);
  assert.deepEqual(filterIssues(issues, { label: "bug", status: "open" }).map((issue) => issue.id), ["a"]);
});
test("blank filter and original order", () => {
  assert.deepEqual(filterIssues(issues, { label: "  " }).map((issue) => issue.id), ["a", "b", "c"]);
  assert.deepEqual(filterIssues(issues, { status: "open" }).map((issue) => issue.id), ["a", "c"]);
});
test("aggregate distinct labels and estimates", () => {
  assert.deepEqual(summarizeIssues(issues), {
    total: 3, open: 2, closed: 1, estimateTotal: 5.5,
    byLabel: { api: 1, bug: 2, debug: 1, ui: 1 },
  });
});
test("unusual label names are safe", () => {
  const summary = summarizeIssues([{ id: "x", status: "open", labels: ["__proto__", "constructor", "  "], estimate: 1 }]);
  assert.deepEqual(Object.keys(summary.byLabel), ["__proto__", "constructor"]);
  assert.equal(Object.getOwnPropertyDescriptor(summary.byLabel, "__proto__").value, 1);
  assert.equal(summary.byLabel.constructor, 1);
});
test("rendering sorts independently of input object order", () => {
  assert.equal(renderSummary({ total: 2, open: 1, closed: 1, estimateTotal: 4, byLabel: { z: 1, a: 2 } }),
    "Issues: 2 (open: 1, closed: 1)\nEstimate: 4\nLabels: a=2, z=1");
});
test("end-to-end filtering precedes aggregation", () => {
  assert.equal(buildReport(issues, { status: "closed", label: "BUG" }),
    "Issues: 1 (open: 0, closed: 1)\nEstimate: 3.5\nLabels: bug=1, ui=1");
});
test("empty results and invalid selected estimates", () => {
  assert.equal(buildReport(issues, { label: "missing" }),
    "Issues: 0 (open: 0, closed: 0)\nEstimate: 0\nLabels: -");
  for (const estimate of [-1, NaN, Infinity]) {
    assert.throws(() => summarizeIssues([{ ...issues[0], estimate }]), RangeError);
  }
  assert.equal(buildReport([{ ...issues[0], estimate: -1 }], { status: "closed" }),
    "Issues: 0 (open: 0, closed: 0)\nEstimate: 0\nLabels: -");
});
test("inputs are not mutated", () => {
  const input = Object.freeze(issues.map((issue) => Object.freeze({ ...issue, labels: Object.freeze([...issue.labels]) })));
  const before = JSON.stringify(input);
  buildReport(input, { label: "bug" });
  assert.equal(JSON.stringify(input), before);
});
