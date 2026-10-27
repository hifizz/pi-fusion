import type { FilterOptions, Issue } from "./types.ts";
export function filterIssues(issues: Issue[], options: FilterOptions = {}): Issue[] {
  const label = options.label?.trim().toLowerCase();
  return issues.filter((issue) => (!options.status || issue.status === options.status)
    && (!label || issue.labels.some((value) => value.trim().toLowerCase() === label)));
}
