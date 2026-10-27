import type { FilterOptions, Issue, Summary } from "./types.ts";
import { summarizeIssues } from "./summary.ts";
export function renderSummary(summary: Summary): string {
  return `Issues: ${summary.total} (open: ${summary.open}, closed: ${summary.closed})\nEstimate: ${summary.estimateTotal}\nLabels: -`;
}
export function buildReport(issues: Issue[], options: FilterOptions = {}): string {
  return renderSummary(summarizeIssues(issues));
}
