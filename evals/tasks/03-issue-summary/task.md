Implement the issue-report feature across `src/filter.ts`, `src/summary.ts`, and `src/report.ts`, preserving the exported types/signatures.

- `filterIssues(issues, options = {})`: optional status filter and optional label filter combined with AND. Label matching trims and lowercases both sides and matches whole labels. An omitted/blank label disables that filter. Keep original order; do not mutate issues or their labels.
- `summarizeIssues(issues)`: return total/open/closed counts, sum of estimates, and `byLabel`. For each issue count each distinct trimmed, lowercased, nonempty label once. The keys of `byLabel` must be inserted in ascending JavaScript string order, including unusual names such as `__proto__`. Every selected issue must have a finite, nonnegative estimate, otherwise throw `RangeError`.
- `renderSummary(summary)`: exactly three lines, no trailing newline:
  `Issues: N (open: O, closed: C)`
  `Estimate: E`
  `Labels: a=1, b=2`
  Render labels in ascending string order. With no labels the last line is `Labels: -`.
- `buildReport(issues, options = {})`: filter, then summarize and render. Only selected issues contribute to counts, estimates and labels.

You may add tests. Do not change the supplied public tests or package manifest. Run `npm test`; no third-party dependencies are needed.
