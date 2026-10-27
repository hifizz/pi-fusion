import type { CartLine } from "./types.ts";
export function subtotal(lines: CartLine[]): number {
  return lines.reduce((sum, line) => sum + line.unitPriceCents, 0);
}
