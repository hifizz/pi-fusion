import type { Issue, Summary } from "./types.ts";
export function summarizeIssues(issues: Issue[]): Summary {
  return { total: issues.length, open: 0, closed: 0, estimateTotal: 0, byLabel: {} };
}
