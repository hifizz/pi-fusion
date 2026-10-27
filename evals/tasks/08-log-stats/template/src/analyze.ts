export function analyze(text: string): {
  count: number; totalDuration: number; errorCount: number; byService: Record<string, number>;
} {
  let count = 0, totalDuration = 0, errorCount = 0;
  const services = new Map<string, number>();
  for (const line of text.split(/\r?\n/)) {
    const fields = line.split("|").map((value) => value.trim());
    if (fields.length !== 3) continue;
    const [rawLevel, service, rawDuration] = fields;
    const level = rawLevel.toUpperCase();
    const duration = Number(rawDuration);
    if (!["DEBUG", "INFO", "WARN", "ERROR"].includes(level)
      || !service || !rawDuration || !Number.isFinite(duration) || duration < 0) continue;
    count++; totalDuration += duration;
    if (level === "ERROR") errorCount++;
    services.set(service, (services.get(service) ?? 0) + 1);
  }
  return {
    count, totalDuration, errorCount,
    byService: Object.fromEntries([...services.keys()].sort().map((service) => [service, services.get(service)!])),
  };
}
