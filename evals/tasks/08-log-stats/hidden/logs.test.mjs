import test from "node:test";
import assert from "node:assert/strict";
import { analyze } from "../src/analyze.ts";
import { parseLine } from "../src/parser.ts";
import { summarize } from "../src/stats.ts";
test("parser normalizes valid fields and retains zero", () => {
  assert.deepEqual(parseLine(" info | api | 0 "), { level: "INFO", service: "api", duration: 0 });
  assert.deepEqual(parseLine("ERROR|db|1.25"), { level: "ERROR", service: "db", duration: 1.25 });
});
test("parser rejects malformed fields", () => {
  for (const line of ["", "INFO|a", "INFO|a|1|extra", "NOPE|a|1", "INFO||1", "INFO|a|",
    "INFO|a| ", "INFO|a|-1", "INFO|a|NaN", "INFO|a|Infinity"]) assert.equal(parseLine(line), null, line);
});
test("standalone aggregation counts services and errors", () => {
  assert.deepEqual(summarize([
    { level: "ERROR", service: "z", duration: 2 },
    { level: "INFO", service: "a", duration: 3 },
    { level: "WARN", service: "z", duration: 0.5 },
  ]), { count: 3, totalDuration: 5.5, errorCount: 1, byService: { a: 1, z: 2 } });
});
test("empty input behavior", () => {
  const empty = { count: 0, totalDuration: 0, errorCount: 0, byService: {} };
  assert.deepEqual(analyze(""), empty);
  assert.deepEqual(summarize([]), empty);
});
test("analyze composes parser and aggregator across CRLF", () => {
  assert.deepEqual(analyze("info|web|0\r\nbad\r\nERROR|api|1\r\nWARN|web|2.5"), {
    count: 3, totalDuration: 3.5, errorCount: 1, byService: { api: 1, web: 2 },
  });
});
test("service names do not collide with object prototype", () => {
  const result = analyze("INFO|__proto__|1\nERROR|constructor|2");
  assert.deepEqual(Object.keys(result.byService), ["__proto__", "constructor"]);
  assert.equal(Object.getOwnPropertyDescriptor(result.byService, "__proto__").value, 1);
  assert.equal(result.byService.constructor, 1);
});
test("aggregation accepts frozen inputs without mutation", () => {
  const entry = Object.freeze({ level: "DEBUG", service: "worker", duration: 3 });
  const entries = Object.freeze([entry]);
  assert.deepEqual(summarize(entries), {
    count: 1, totalDuration: 3, errorCount: 0, byService: { worker: 1 },
  });
});
