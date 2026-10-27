Complete `toSlug(text)` in `src/slug.ts`.
Normalize with Unicode NFKD, remove combining marks, and lowercase.
Replace each run of characters outside ASCII a-z and 0-9 with one hyphen, then remove leading/trailing hyphens.
Empty input or input containing no ASCII letters/digits after normalization returns an empty string.
Do not mutate inputs or add dependencies. Run `npm test`.
