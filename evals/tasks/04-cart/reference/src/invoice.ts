import type { CartLine, Discount, Invoice } from "./types.ts";
import { subtotal } from "./cart.ts";
import { discountFor } from "./discount.ts";
export function createInvoice(lines: CartLine[], discount?: Discount): Invoice {
  const subtotalCents = subtotal(lines);
  const discountCents = discountFor(subtotalCents, discount);
  return { subtotalCents, discountCents, totalCents: subtotalCents - discountCents };
}
