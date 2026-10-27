Refactor the monolithic `analyze(text)` in `src/analyze.ts` into independently usable modules while preserving its output.

Create:
- `src/parser.ts`: export the `LogEntry` type `{level:"DEBUG"|"INFO"|"WARN"|"ERROR", service:string, duration:number}` and `parseLine(line): LogEntry | null`.
- `src/stats.ts`: export `summarize(entries: LogEntry[])`, returning `{count,totalDuration,errorCount,byService}`.
- Keep `analyze(text)` exported from `src/analyze.ts`, composing parsing and aggregation.

Input lines have exactly three `|`-separated fields. Trim fields, uppercase the level, reject unknown levels or empty services/durations. A duration must convert with Number to a finite nonnegative number. Invalid lines are ignored. Empty input yields all zero counts and an empty byService object.
Each valid entry contributes to its service count; insert service keys in ascending JavaScript string order and safely handle names such as `__proto__`. `summarize` does not mutate entries.
Preserve the existing public tests, add focused tests as needed, and run `npm test`. No dependencies.
