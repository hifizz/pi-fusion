export interface LogEntry { level: "DEBUG" | "INFO" | "WARN" | "ERROR"; service: string; duration: number }
export function parseLine(line: string): LogEntry | null {
  const fields = line.split("|").map((value) => value.trim());
  if (fields.length !== 3) return null;
  const [rawLevel, service, rawDuration] = fields;
  const level = rawLevel.toUpperCase();
  const duration = Number(rawDuration);
  if (!["DEBUG", "INFO", "WARN", "ERROR"].includes(level)
    || !service || !rawDuration || !Number.isFinite(duration) || duration < 0) return null;
  return { level: level as LogEntry["level"], service, duration };
}
