import test from "node:test";
import assert from "node:assert/strict";
import { EventBus } from "../src/bus.ts";
test("one listener receives its payload", () => {
  const bus = new EventBus();
  const values = [];
  bus.on("data", (value) => values.push(value));
  assert.equal(bus.emit("data", 42), 1);
  assert.deepEqual(values, [42]);
});
