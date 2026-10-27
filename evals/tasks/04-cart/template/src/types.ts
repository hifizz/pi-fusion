export interface CartLine { sku: string; unitPriceCents: number; quantity: number }
export type Discount = { type: "fixed"; cents: number } | { type: "percent"; percent: number };
export interface Invoice { subtotalCents: number; discountCents: number; totalCents: number }
