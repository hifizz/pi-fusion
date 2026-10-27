Implement the shopping-cart feature in `src/cart.ts`, `src/discount.ts`, and `src/invoice.ts`.
Use integer cents throughout and preserve the exported interfaces.

- `subtotal(lines)`: sum unitPriceCents * quantity. Each unit price is a nonnegative safe integer; each quantity is a positive safe integer. Throw RangeError for invalid values or a subtotal outside the safe-integer range. Duplicate SKU lines are valid and both contribute. Empty cart costs zero.
- `discountFor(subtotalCents, discount?)`: no discount means zero. A fixed discount must have nonnegative safe-integer `cents` and is capped at the subtotal. A percentage must be finite and in [0,100]; compute `Math.floor(subtotalCents * percent / 100)`. Validate the subtotal using the same nonnegative safe-integer rule. Throw RangeError on invalid values.
- `createInvoice(lines, discount?)`: compose the two helpers and return `{subtotalCents, discountCents, totalCents}` where total is subtotal minus discount.

Do not mutate inputs. Add focused tests if useful and run `npm test`. No dependencies are needed.
