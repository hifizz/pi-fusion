import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { aggregateCosts, formatCost, isFusionEntry, mergeCosts, object, totalTokens } from "./costs.ts";
import type { FusionCosts } from "./costs.ts";

export interface SessionCostRow extends FusionCosts { file: string; date: string; cwd: string; sessionId: string }
export interface SessionCosts { sessions: SessionCostRow[]; grandTotal: FusionCosts; malformedLines: number; duplicateEntries: number }
function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}
export function defaultSessionsDir(): string {
  return expandHome(process.env.PI_CODING_AGENT_SESSION_DIR || join(getAgentDir(), "sessions"));
}
function filesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((item) => {
    const path = join(dir, item.name);
    return item.isDirectory() ? filesIn(path) : item.isFile() && item.name.endsWith(".jsonl") ? [path] : [];
  });
}
export function summarizeSessions(dir: string, since?: string): SessionCosts {
  if (since !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(since)
    || !Number.isFinite(Date.parse(`${since}T00:00:00Z`))
    || new Date(`${since}T00:00:00Z`).toISOString().slice(0, 10) !== since)) {
    throw new Error("--since must be a valid date in YYYY-MM-DD format");
  }
  const cutoff = since === undefined ? -Infinity : Date.parse(`${since}T00:00:00Z`);
  let malformedLines = 0;
  const parsed = filesIn(resolve(expandHome(dir))).map((file) => {
    let header: Record<string, unknown> = {};
    const entries: Record<string, unknown>[] = [];
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const value: unknown = JSON.parse(line);
        if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
        const entry = object(value);
        if (entry.type === "session" && header.type === undefined) header = entry;
        else if (isFusionEntry(entry)) entries.push(entry);
      } catch { malformedLines++; }
    }
    const timestamp = typeof header.timestamp === "string" ? Date.parse(header.timestamp) : NaN;
    return { file, header, entries, timestamp };
  }).filter((session) => session.entries.length > 0)
    .sort((a, b) => (Number.isFinite(a.timestamp) ? a.timestamp : Infinity)
      - (Number.isFinite(b.timestamp) ? b.timestamp : Infinity) || a.file.localeCompare(b.file));
  const seen = new Set<string>();
  let duplicateEntries = 0;
  const sessions: SessionCostRow[] = [];
  for (const session of parsed) {
    // Fork/clone copies preserve entry IDs and timestamps. Attribute shared history
    // to the oldest scanned session, even when it predates --since.
    const entries = session.entries.filter((entry) => {
      if (typeof entry.id !== "string" || typeof entry.timestamp !== "string") return true;
      const key = JSON.stringify([entry.id, entry.timestamp]);
      if (seen.has(key)) { duplicateEntries++; return false; }
      seen.add(key);
      return true;
    });
    if (since !== undefined && (!Number.isFinite(session.timestamp) || session.timestamp < cutoff)) continue;
    const summary = aggregateCosts(entries);
    for (const role of ["lead", "sidekick"] as const) {
      if (summary[role].models.length) continue;
      summary[role].models = [...new Set(session.entries.flatMap((entry) => {
        const data = object(entry.data);
        const model = entry.customType === `fusion.${role}_usage` ? data.model
          : entry.customType === "fusion.models" ? data[`${role}Model`] : undefined;
        return typeof model === "string" && model.trim() ? [model] : [];
      }))];
    }
    sessions.push({
      file: session.file,
      date: Number.isFinite(session.timestamp) ? new Date(session.timestamp).toISOString().slice(0, 10) : "unknown",
      cwd: typeof session.header.cwd === "string" ? session.header.cwd : "unknown",
      sessionId: typeof session.header.id === "string" ? session.header.id : "unknown",
      ...summary,
    });
  }
  return { sessions, grandTotal: mergeCosts(sessions), malformedLines, duplicateEntries };
}
export function formatSessions(result: SessionCosts): string {
  const cell = (value: string | number) => String(value).replace(/[\r\n\t|\x00-\x1f\x7f]/g, " ");
  const row = (values: Array<string | number>) => `| ${values.map(cell).join(" | ")} |`;
  const columns = (summary: FusionCosts) => [totalTokens(summary.lead.usage), formatCost(summary.lead.cost),
    totalTokens(summary.sidekick.usage), formatCost(summary.sidekick.cost), formatCost(summary.total)];
  return [
    row(["Date", "Cwd/project", "Lead model", "Sidekick model", "Lead tokens", "Lead USD", "Sidekick tokens", "Sidekick USD", "Total USD"]),
    row(Array<string>(9).fill("---")),
    ...result.sessions.map((session) => row([session.date, session.cwd, session.lead.models.join(", ") || "—",
      session.sidekick.models.join(", ") || "—", ...columns(session)])),
    row([`TOTAL (${result.sessions.length} sessions)`, "—", "—", "—", ...columns(result.grandTotal)]),
    "USD estimates from Pi's configured rates, not a bill. Tokens include uncached input, cached input, cache writes, and output.",
    ...(result.malformedLines ? [`Skipped ${result.malformedLines} malformed line(s); recorded totals may be incomplete.`] : []),
    ...(result.duplicateEntries ? [`Excluded ${result.duplicateEntries} copied/duplicate Fusion entries from totals.`] : []),
    ...(result.grandTotal.invalidEntries ? [`Ignored ${result.grandTotal.invalidEntries} invalid usage entry/entries.`] : []),
    ...(result.grandTotal.incompleteCalls ? [`${result.grandTotal.incompleteCalls} sidekick call(s) have no final snapshot; recorded usage may be incomplete.`] : []),
  ].join("\n");
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { since: { type: "string" }, dir: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean" } } });
    if (values.help) console.log("pnpm fusion:costs [--since YYYY-MM-DD] [--dir <sessions dir>] [--json]");
    else {
      const dir = expandHome(values.dir ?? defaultSessionsDir());
      if (values.dir !== undefined && !existsSync(dir)) throw new Error("Sessions directory does not exist");
      const result = summarizeSessions(dir, values.since);
      console.log(values.json ? JSON.stringify(result, null, 2) : formatSessions(result));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Unable to read session costs");
    process.exitCode = 1;
  }
}
