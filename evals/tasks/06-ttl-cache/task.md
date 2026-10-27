Fix the cache bugs in `src/cache.ts` while preserving `TTLCache<T>` and its public methods.
The injected `now()` clock returns milliseconds.

Contract:
- `set(key, value, ttlMs)` replaces both value and expiration. ttlMs must be finite and >= 0; invalid TTLs throw RangeError.
- Entries expire when now >= setTime + ttlMs. A zero TTL is immediately expired.
- `get(key)` returns the live value or undefined; `has(key)` must distinguish a live stored undefined from a missing entry.
- `size()` counts only live entries and cleans up expired ones.

Reproduce the failures using a controlled clock, diagnose the interacting issues, fix them, and run `npm test`. Do not add dependencies.
