import type { Issue, Summary } from "./types.ts";
export function summarizeIssues(issues: Issue[]): Summary {
  let open = 0;
  let estimateTotal = 0;
  const labels = new Map<string, number>();
  for (const issue of issues) {
    if (!Number.isFinite(issue.estimate) || issue.estimate < 0) throw new RangeError("Invalid estimate");
    if (issue.status === "open") open++;
    estimateTotal += issue.estimate;
    for (const label of new Set(issue.labels.map((value) => value.trim().toLowerCase()).filter(Boolean))) {
      labels.set(label, (labels.get(label) ?? 0) + 1);
    }
  }
  return {
    total: issues.length, open, closed: issues.length - open, estimateTotal,
    byLabel: Object.fromEntries([...labels.keys()].sort().map((label) => [label, labels.get(label)!])),
  };
}
