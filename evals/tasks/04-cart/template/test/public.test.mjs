import test from "node:test";
import assert from "node:assert/strict";
import { createInvoice } from "../src/invoice.ts";
test("empty invoice", () => {
  assert.deepEqual(createInvoice([]), { subtotalCents: 0, discountCents: 0, totalCents: 0 });
});
