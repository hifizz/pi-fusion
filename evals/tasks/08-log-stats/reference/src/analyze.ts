import { parseLine } from "./parser.ts";
import type { LogEntry } from "./parser.ts";
import { summarize } from "./stats.ts";
export function analyze(text: string) {
  return summarize(text.split(/\r?\n/).map(parseLine).filter((entry): entry is LogEntry => entry !== null));
}
