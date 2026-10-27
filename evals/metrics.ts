import { addUsage, cacheHitRate, emptyUsage, usageFromPi } from "../src/usage.ts";
import type { TokenUsage } from "../src/usage.ts";
import type { Cost, EvalConfig, Metrics, ModelMetrics, Pricing, Rates } from "./types.ts";

export type JsonObject = Record<string, unknown>;
export function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

/** Split only on LF; U+2028/U+2029 are legal JSON string characters. */
export function parseJsonl(text: string): JsonObject[] {
  return text.split("\n").flatMap((raw, index) => {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trim() === "") return [];
    try {
      const value: unknown = JSON.parse(line);
      if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
      return [value as JsonObject];
    } catch {
      // Never include the offending line: diagnostics may contain credentials.
      throw new Error(`Invalid JSONL object at line ${index + 1}`);
    }
  });
}

export function parsePiEvents(text: string): { events: JsonObject[]; warnings: string[] } {
  const events: JsonObject[] = [];
  const warnings: string[] = [];
  text.split("\n").forEach((line, index) => {
    if (line.trim() === "") return;
    try {
      const [event] = parseJsonl(line);
      if (typeof event.type !== "string") throw new Error();
      events.push(event);
    } catch {
      warnings.push(`Unreadable Pi JSON event at line ${index + 1}`);
    }
  });
  return { events, warnings };
}

function modelMetrics(): ModelMetrics {
  return { usage: emptyUsage(), cacheHitRate: null, turns: 0, toolCalls: 0, writeToolCalls: 0 };
}
function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Invalid nonnegative counter");
  }
  return value;
}
function progressUsage(value: unknown): TokenUsage {
  const usage = object(value);
  return {
    input: count(usage.input), cachedInput: count(usage.cachedInput),
    cacheWrite: count(usage.cacheWrite), output: count(usage.output),
  };
}

export function collectMetrics(events: JsonObject[], initialWarnings: string[] = []): Metrics {
  const lead = modelMetrics();
  const sidekick = modelMetrics();
  const snapshots = new Map<string, ModelMetrics>();
  const sidekickCalls = new Set<string>();
  const completedSidekickCalls = new Set<string>();
  const sessionIds = new Set<string>();
  const leadModels = new Set<string>();
  const sidekickModels = new Set<string>();
  const mutations = new Set<string>();
  const changedFiles = new Set<string>();
  const warnings = [...initialWarnings];
  let telemetry = false;
  for (const event of events) {
    try {
      if (event.type === "turn_start") lead.turns++;
      if (event.type === "tool_execution_start") {
        lead.toolCalls++;
        if (event.toolName === "write" || event.toolName === "edit") lead.writeToolCalls++;
        if (event.toolName === "sidekick") sidekickCalls.add(String(event.toolCallId));
      }
      if (event.type === "tool_execution_end" && event.toolName === "sidekick") {
        completedSidekickCalls.add(String(event.toolCallId));
      }
      if (event.type === "message_end") {
        const message = object(event.message);
        if (message.role === "assistant") {
          lead.usage = addUsage(lead.usage, usageFromPi(message.usage));
          leadModels.add(`${message.provider}/${message.model}`);
        }
      }
      if (event.type !== "entry_appended") continue;
      const entry = object(event.entry);
      const data = object(entry.data);
      if (entry.customType === "fusion.telemetry_ready") telemetry = true;
      if (entry.customType === "fusion.lead_mutation") {
        if (typeof data.toolCallId !== "string" || !Array.isArray(data.changedFiles)) {
          throw new Error("Invalid mutation record");
        }
        mutations.add(data.toolCallId);
        for (const file of data.changedFiles) if (typeof file === "string") changedFiles.add(file);
      }
      if (entry.customType === "fusion.sidekick_usage") {
        if (typeof data.sessionId !== "string" || typeof data.model !== "string") {
          throw new Error("Invalid sidekick identity");
        }
        const call = count(data.call);
        if (call < 1) throw new Error("Invalid sidekick call");
        const usage = progressUsage(data.usage);
        const key = `${data.sessionId}:${call}`;
        const previous = snapshots.get(key);
        if (previous && Object.keys(usage).some(
          (field) => usage[field as keyof TokenUsage] < previous.usage[field as keyof TokenUsage],
        )) throw new Error("Decreasing sidekick usage");
        snapshots.set(key, {
          usage, cacheHitRate: cacheHitRate(usage), turns: count(data.turns),
          toolCalls: count(data.toolCalls), writeToolCalls: count(data.writeToolCalls),
        });
        sessionIds.add(data.sessionId);
        sidekickModels.add(data.model);
      }
    } catch {
      warnings.push(`Invalid metrics in ${String(event.type)} event`);
    }
  }
  // Progress is cumulative within a call. Only the last snapshot of each call is added.
  for (const snapshot of snapshots.values()) {
    sidekick.usage = addUsage(sidekick.usage, snapshot.usage);
    sidekick.turns += snapshot.turns;
    sidekick.toolCalls += snapshot.toolCalls;
    sidekick.writeToolCalls += snapshot.writeToolCalls;
  }
  if ([...sidekickCalls].some((id) => !completedSidekickCalls.has(id))) {
    warnings.push("An unfinished sidekick call may have unreported billed tokens");
  }
  if (!events.some((event) => event.type === "agent_settled")) {
    warnings.push("Pi did not emit agent_settled; final usage may be missing");
  }
  lead.cacheHitRate = cacheHitRate(lead.usage);
  sidekick.cacheHitRate = cacheHitRate(sidekick.usage);
  return {
    lead, sidekick, sidekickCalls: sidekickCalls.size, sidekickSessionIds: [...sessionIds],
    leadWriteCalls: telemetry ? mutations.size : null, leadChangedFiles: [...changedFiles].sort(),
    observedLeadModels: [...leadModels], observedSidekickModels: [...sidekickModels],
    usageComplete: warnings.length === 0, warnings,
  };
}

export function validatePricing(value: unknown): Pricing {
  const pricing = object(value);
  if (pricing.currency !== "USD" || pricing.unit !== "per_million_tokens") {
    throw new Error("Pricing must use USD per million tokens");
  }
  const models = object(pricing.models);
  if (Object.keys(models).length === 0) throw new Error("Pricing has no models");
  for (const rates of Object.values(models)) {
    const row = object(rates);
    if (typeof row.source !== "string" || !row.source || typeof row.asOf !== "string"
      || !/^\d{4}-\d{2}-\d{2}$/.test(row.asOf)) throw new Error("Pricing requires source and date");
    for (const field of ["input", "cachedInput", "cacheWrite", "output"]) {
      if (row[field] !== null && (typeof row[field] !== "number"
        || !Number.isFinite(row[field]) || (row[field] as number) < 0)) {
        throw new Error(`Invalid price for ${field}`);
      }
    }
  }
  return value as Pricing;
}

export function costForUsage(usage: TokenUsage, rates?: Rates): {
  total: number | null; known: number;
} {
  let known = 0;
  let complete = true;
  for (const field of ["input", "cachedInput", "cacheWrite", "output"] as const) {
    const tokens = count(usage[field]);
    if (tokens === 0) continue;
    const rate = rates?.[field];
    if (rate === undefined || rate === null) complete = false;
    else known += tokens * rate / 1_000_000;
  }
  return { total: complete ? known : null, known };
}

export function estimateCost(config: EvalConfig, metrics: Metrics, pricing: Pricing): Cost {
  const leadMatches = metrics.observedLeadModels.every((model) => model === config.lead);
  const sidekickMatches = metrics.observedSidekickModels.every((model) => model === config.sidekick);
  const lead = costForUsage(metrics.lead.usage, leadMatches ? pricing.models[config.lead] : undefined);
  const sidekick = costForUsage(metrics.sidekick.usage,
    config.sidekick && sidekickMatches ? pricing.models[config.sidekick] : undefined);
  const complete = metrics.usageComplete && lead.total !== null && sidekick.total !== null;
  return {
    leadUsd: lead.total, sidekickUsd: sidekick.total,
    totalUsd: complete ? lead.total! + sidekick.total! : null,
    knownUsd: lead.known + sidekick.known, complete,
  };
}
