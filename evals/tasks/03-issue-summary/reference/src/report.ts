import type { FilterOptions, Issue, Summary } from "./types.ts";
import { filterIssues } from "./filter.ts";
import { summarizeIssues } from "./summary.ts";
export function renderSummary(summary: Summary): string {
  const labels = Object.keys(summary.byLabel).sort().map((key) => `${key}=${summary.byLabel[key]}`).join(", ");
  return `Issues: ${summary.total} (open: ${summary.open}, closed: ${summary.closed})\nEstimate: ${summary.estimateTotal}\nLabels: ${labels || "-"}`;
}
export function buildReport(issues: Issue[], options: FilterOptions = {}): string {
  return renderSummary(summarizeIssues(filterIssues(issues, options)));
}
