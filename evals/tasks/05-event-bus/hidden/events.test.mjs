import test from "node:test";
import assert from "node:assert/strict";
import { EventBus } from "../src/bus.ts";
import { SubscriptionStore } from "../src/registry.ts";
import { record } from "../src/history.ts";
test("listeners preserve registration order", () => {
  const bus = new EventBus(), values = [];
  bus.on("x", () => values.push("a"));
  bus.on("x", () => values.push("b"));
  assert.equal(bus.emit("x", null), 2);
  assert.deepEqual(values, ["a", "b"]);
  assert.equal(bus.emit("missing", null), 0);
});
test("duplicate callbacks have independent subscriptions", () => {
  const bus = new EventBus();
  let calls = 0;
  const listener = () => calls++;
  const first = bus.on("x", listener);
  const second = bus.on("x", listener);
  first(); first();
  assert.equal(bus.emit("x", 1), 1);
  assert.equal(calls, 1);
  second();
  assert.equal(bus.emit("x", 1), 0);
});
test("once removes itself before reentrant emit", () => {
  const bus = new EventBus();
  let calls = 0;
  bus.once("x", () => { calls++; if (calls < 3) bus.emit("x", 2); });
  assert.equal(bus.emit("x", 1), 1);
  assert.equal(calls, 1);
  assert.equal(bus.emit("x", 3), 0);
  const nested = new EventBus();
  let reentered = false, onceCalls = 0;
  nested.on("x", () => {
    if (!reentered) { reentered = true; nested.emit("x", 2); }
  });
  nested.once("x", () => onceCalls++);
  nested.emit("x", 1);
  assert.equal(onceCalls, 1);
});
test("an unsubscribe during emit affects the next emission", () => {
  const bus = new EventBus(), values = [];
  let stopB;
  bus.on("x", () => { values.push("a"); stopB(); });
  stopB = bus.on("x", () => values.push("b"));
  assert.equal(bus.emit("x", 0), 2);
  assert.deepEqual(values, ["a", "b"]);
  values.length = 0;
  assert.equal(bus.emit("x", 0), 1);
  assert.deepEqual(values, ["a"]);
});
test("new subscriptions wait for the next emission", () => {
  const bus = new EventBus(), values = [];
  bus.once("x", () => { values.push("a"); bus.on("x", () => values.push("b")); });
  bus.emit("x", 0);
  assert.deepEqual(values, ["a"]);
  bus.emit("x", 0);
  assert.deepEqual(values, ["a", "b"]);
});
test("registry snapshots are detached", () => {
  const store = new SubscriptionStore();
  const listener = () => {};
  store.add("x", listener);
  const snapshot = store.list("x");
  snapshot.length = 0;
  assert.deepEqual(store.list("x"), [listener]);
});
test("history records nullish payloads and stops idempotently", () => {
  const bus = new EventBus();
  const history = record(bus, "x");
  bus.emit("other", 7); bus.emit("x", undefined); bus.emit("x", null); bus.emit("x", 0);
  history.stop(); history.stop(); bus.emit("x", "late");
  assert.deepEqual(history.events, [undefined, null, 0]);
});
test("events are separate and listener errors propagate", () => {
  const bus = new EventBus(), seen = [];
  bus.on("y", () => seen.push("y"));
  const error = new Error("listener failed");
  bus.on("x", () => { throw error; });
  assert.throws(() => bus.emit("x", 0), (value) => value === error);
  assert.deepEqual(seen, []);
  bus.emit("y", 0);
  assert.deepEqual(seen, ["y"]);
});
