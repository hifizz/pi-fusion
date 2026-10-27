import type { CartLine, Discount, Invoice } from "./types.ts";
import { subtotal } from "./cart.ts";
export function createInvoice(lines: CartLine[], discount?: Discount): Invoice {
  const subtotalCents = subtotal(lines);
  return { subtotalCents, discountCents: 0, totalCents: subtotalCents };
}
