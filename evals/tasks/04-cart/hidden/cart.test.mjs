import test from "node:test";
import assert from "node:assert/strict";
import { subtotal } from "../src/cart.ts";
import { discountFor } from "../src/discount.ts";
import { createInvoice } from "../src/invoice.ts";
const line = (unitPriceCents, quantity = 1) => ({ sku: "same", unitPriceCents, quantity });
test("quantities and duplicate SKUs contribute", () => {
  assert.equal(subtotal([line(199, 3), line(50, 2)]), 697);
});
test("invalid quantity or price", () => {
  for (const quantity of [0, -1, 1.5, NaN, Infinity]) assert.throws(() => subtotal([line(10, quantity)]), RangeError);
  for (const price of [-1, 1.5, NaN, Infinity]) assert.throws(() => subtotal([line(price)]), RangeError);
});
test("safe integer overflow", () => {
  assert.throws(() => subtotal([line(Number.MAX_SAFE_INTEGER), line(1)]), RangeError);
  assert.throws(() => subtotal([line(Number.MAX_SAFE_INTEGER, 2)]), RangeError);
});
test("fixed discount is capped", () => {
  assert.equal(discountFor(100, { type: "fixed", cents: 150 }), 100);
  assert.equal(discountFor(100, { type: "fixed", cents: 25 }), 25);
});
test("percentage rounds down and accepts boundary percentages", () => {
  assert.equal(discountFor(999, { type: "percent", percent: 12.5 }), 124);
  assert.equal(discountFor(10, { type: "percent", percent: 100 }), 10);
  assert.equal(discountFor(10, { type: "percent", percent: 0 }), 0);
});
test("invalid discounts and subtotals", () => {
  for (const cents of [-1, 0.5, Infinity]) assert.throws(() => discountFor(100, { type: "fixed", cents }), RangeError);
  for (const percent of [-1, 101, NaN, Infinity]) assert.throws(() => discountFor(100, { type: "percent", percent }), RangeError);
  assert.throws(() => discountFor(-1), RangeError);
  assert.throws(() => discountFor(0.1), RangeError);
});
test("invoice integrates validation and discount", () => {
  assert.deepEqual(createInvoice([line(125, 4)], { type: "percent", percent: 10 }),
    { subtotalCents: 500, discountCents: 50, totalCents: 450 });
  assert.throws(() => createInvoice([line(5, 0)]), RangeError);
});
test("empty and immutable inputs", () => {
  assert.deepEqual(createInvoice([], { type: "fixed", cents: 50 }), { subtotalCents: 0, discountCents: 0, totalCents: 0 });
  const lines = Object.freeze([Object.freeze(line(50, 2))]);
  const discount = Object.freeze({ type: "fixed", cents: 10 });
  assert.deepEqual(createInvoice(lines, discount), { subtotalCents: 100, discountCents: 10, totalCents: 90 });
});
