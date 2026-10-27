import type { CartLine } from "./types.ts";
export function subtotal(lines: CartLine[]): number {
  let sum = 0;
  for (const line of lines) {
    if (!Number.isSafeInteger(line.unitPriceCents) || line.unitPriceCents < 0
      || !Number.isSafeInteger(line.quantity) || line.quantity < 1) throw new RangeError("Invalid cart line");
    sum += line.unitPriceCents * line.quantity;
    if (!Number.isSafeInteger(sum)) throw new RangeError("Subtotal overflow");
  }
  return sum;
}
