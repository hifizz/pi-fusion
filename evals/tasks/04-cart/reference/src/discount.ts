import type { Discount } from "./types.ts";
export function discountFor(subtotalCents: number, discount?: Discount): number {
  if (!Number.isSafeInteger(subtotalCents) || subtotalCents < 0) throw new RangeError("Invalid subtotal");
  if (!discount) return 0;
  if (discount.type === "fixed") {
    if (!Number.isSafeInteger(discount.cents) || discount.cents < 0) throw new RangeError("Invalid fixed discount");
    return Math.min(subtotalCents, discount.cents);
  }
  if (!Number.isFinite(discount.percent) || discount.percent < 0 || discount.percent > 100) {
    throw new RangeError("Invalid percentage");
  }
  return Math.floor(subtotalCents * discount.percent / 100);
}
