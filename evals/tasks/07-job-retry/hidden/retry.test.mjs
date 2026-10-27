import test from "node:test";
import assert from "node:assert/strict";
import { retry } from "../src/retry.ts";
import { processJobs } from "../src/worker.ts";
test("async failures retry with one-based attempts and correct exponential delays", async () => {
  const seen = [], delays = [];
  const value = await retry(async (attempt) => {
    seen.push(attempt);
    await Promise.resolve();
    if (attempt < 3) throw new Error("temporary");
    return "ok";
  }, { attempts: 3, delayMs: 5, sleep: async (delay) => { delays.push(delay); } });
  assert.equal(value, "ok");
  assert.deepEqual(seen, [1, 2, 3]);
  assert.deepEqual(delays, [5, 10]);
});
test("last error identity and no final sleep", async () => {
  const errors = [new Error("first"), new Error("last")], delays = [];
  await assert.rejects(retry(async (attempt) => { throw errors[attempt - 1]; }, {
    attempts: 2, delayMs: 7, sleep: async (delay) => { delays.push(delay); },
  }), (error) => error === errors[1]);
  assert.deepEqual(delays, [7]);
});
test("nonretryable errors stop immediately", async () => {
  const original = new Error("permanent"), seen = [];
  await assert.rejects(retry(async () => { throw original; }, {
    attempts: 4, shouldRetry: (error, attempt) => { seen.push([error, attempt]); return false; },
    sleep: async () => assert.fail("must not sleep"),
  }), (error) => error === original);
  assert.deepEqual(seen, [[original, 1]]);
});
test("sequential invocations reset state", async () => {
  assert.equal(await retry(async (attempt) => attempt, { attempts: 1 }), 1);
  assert.equal(await retry(async (attempt) => attempt, { attempts: 1 }), 1);
});
test("concurrent invocations have independent retry counters", async () => {
  const run = () => retry(async (attempt) => {
    await Promise.resolve();
    if (attempt === 1) throw new Error("again");
    return attempt;
  }, { attempts: 2, sleep: async () => {} });
  assert.deepEqual(await Promise.all([run(), run()]), [2, 2]);
});
test("invalid options are rejected before invoking the operation", async () => {
  const operation = async () => assert.fail("must validate first");
  for (const attempts of [0, -1, 1.5, Infinity]) {
    await assert.rejects(retry(operation, { attempts }), RangeError);
  }
  for (const delayMs of [-1, NaN, Infinity]) {
    await assert.rejects(retry(operation, { attempts: 1, delayMs }), RangeError);
  }
});
test("worker is sequential and continues after failure", async () => {
  const seen = [], failure = new Error("job failed");
  const results = await processJobs([
    async () => { seen.push("a:start"); await Promise.resolve(); seen.push("a:end"); return 10; },
    async () => { seen.push("b"); throw failure; },
    async () => { seen.push("c"); return 30; },
  ], { attempts: 1 });
  assert.deepEqual(seen, ["a:start", "a:end", "b", "c"]);
  assert.deepEqual(results, [{ ok: true, value: 10 }, { ok: false, error: failure }, { ok: true, value: 30 }]);
});
