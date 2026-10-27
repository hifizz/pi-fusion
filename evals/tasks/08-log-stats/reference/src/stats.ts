import type { LogEntry } from "./parser.ts";
export function summarize(entries: LogEntry[]): {
  count: number; totalDuration: number; errorCount: number; byService: Record<string, number>;
} {
  let totalDuration = 0, errorCount = 0;
  const services = new Map<string, number>();
  for (const entry of entries) {
    totalDuration += entry.duration;
    if (entry.level === "ERROR") errorCount++;
    services.set(entry.service, (services.get(entry.service) ?? 0) + 1);
  }
  return {
    count: entries.length, totalDuration, errorCount,
    byService: Object.fromEntries([...services.keys()].sort().map((service) => [service, services.get(service)!])),
  };
}
