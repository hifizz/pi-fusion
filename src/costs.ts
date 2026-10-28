import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { addUsage, cacheHitRate, emptyUsage } from "./usage.ts";
import type { TokenUsage } from "./usage.ts";

export interface CostTotal {
  usd: number | null;
  knownUsd: number;
  unknownReasons: string[];
}
export interface RoleCost {
  models: string[];
  usage: TokenUsage;
  turns: number;
  calls: number;
  cost: CostTotal;
}
export interface FusionCosts {
  lead: RoleCost;
  sidekick: RoleCost;
  total: CostTotal;
  incompleteCalls: number;
  invalidEntries: number;
}
export interface CostModels { leadModel?: string; sidekickModel?: string }
type RateModel = Pick<Model<Api>, "provider" | "id" | "cost">;
const RATE_FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;
const TOKEN_FIELDS = ["input", "cachedInput", "cacheWrite", "output"] as const;

export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function counter(value: unknown): value is number {
  return nonnegative(value) && Number.isSafeInteger(value);
}
export function recordedPiCost(value: unknown): Usage["cost"] | null {
  const cost = object(value);
  if (![...RATE_FIELDS, "total"].every((key) => nonnegative(cost[key]))) return null;
  return {
    input: cost.input as number, output: cost.output as number,
    cacheRead: cost.cacheRead as number, cacheWrite: cost.cacheWrite as number,
    total: cost.total as number,
  };
}
function modelDefinition(provider: Record<string, unknown>, id: string): Record<string, unknown> | undefined {
  return Array.isArray(provider.models)
    ? provider.models.map(object).find((model) => model.id === id) : undefined;
}
/** Pi replaces omitted custom rates with zeros; only explicit zero rates mean free. */
export function hasConfiguredRates(
  model: RateModel | undefined, registeredProvider?: unknown,
  modelsPath = join(getAgentDir(), "models.json"),
): boolean {
  if (!model) return false;
  const rates = object(model.cost);
  if (!RATE_FIELDS.every((key) => nonnegative(rates[key]))) return false;
  const tiers = Array.isArray(rates.tiers) ? rates.tiers.map(object) : [];
  if ([rates, ...tiers].some((tier) => RATE_FIELDS.some((key) => nonnegative(tier[key]) && tier[key] > 0))) {
    return true;
  }
  let providers: Record<string, unknown> = {};
  try { providers = object(object(JSON.parse(readFileSync(modelsPath, "utf8"))).providers); }
  catch { /* Missing/unreadable config is not evidence of a zero price. */ }
  const provider = object(providers[model.provider]);
  const definition = modelDefinition(object(registeredProvider), model.id) ?? modelDefinition(provider, model.id);
  const override = object(object(provider.modelOverrides)[model.id]);
  const declared = { ...object(definition?.cost), ...object(override.cost) };
  return RATE_FIELDS.every((key) => declared[key] === 0);
}
export function captureCost(usage: Usage, model?: RateModel, registeredProvider?: unknown): {
  cost: Usage["cost"] | null; ratesConfigured: boolean;
} {
  const cost = recordedPiCost(usage.cost);
  return { cost, ratesConfigured: (cost !== null && cost.total > 0) || hasConfiguredRates(model, registeredProvider) };
}
function sumCosts(costs: readonly CostTotal[]): CostTotal {
  const knownUsd = costs.reduce((sum, cost) => sum + cost.knownUsd, 0);
  const unknownReasons = [...new Set(costs.flatMap((cost) => cost.unknownReasons))];
  return { usd: costs.some((cost) => cost.usd === null) ? null : knownUsd, knownUsd, unknownReasons };
}
function emptyRole(): RoleCost {
  return { models: [], usage: emptyUsage(), turns: 0, calls: 0,
    cost: { usd: 0, knownUsd: 0, unknownReasons: [] } };
}
function costOf(data: Record<string, unknown>): CostTotal {
  const cost = recordedPiCost(data.cost);
  const known = cost !== null && (data.ratesConfigured === true || (data.ratesConfigured !== false && cost.total > 0));
  return {
    usd: known ? cost!.total : null, knownUsd: cost?.total ?? 0,
    unknownReasons: known ? [] : [cost ? "no rates configured" : data.cost === undefined ? "cost not recorded" : "invalid recorded cost"],
  };
}
function usageOf(data: Record<string, unknown>): TokenUsage | undefined {
  const usage = object(data.usage);
  if (!TOKEN_FIELDS.every((key) => counter(usage[key]))) return undefined;
  return { input: usage.input as number, cachedInput: usage.cachedInput as number,
    cacheWrite: usage.cacheWrite as number, output: usage.output as number };
}
function addRecord(role: RoleCost, data: Record<string, unknown>, sidekick: boolean): void {
  const model = data.model as string;
  if (!role.models.includes(model)) role.models.push(model);
  role.usage = addUsage(role.usage, usageOf(data)!);
  role.turns += sidekick ? data.turns as number : 1;
  if (sidekick) role.calls++;
  role.cost = sumCosts([role.cost, costOf(data)]);
}
export function isFusionEntry(value: unknown): boolean {
  const entry = object(value);
  return entry.type === "custom" && typeof entry.customType === "string" && entry.customType.startsWith("fusion.");
}
/** Whole-file spending: keep every lead message and only the last snapshot of each call. */
export function aggregateCosts(entries: readonly unknown[], defaults: CostModels = {}): FusionCosts {
  const lead = emptyRole();
  const sidekick = emptyRole();
  const calls = new Map<string, Record<string, unknown>>();
  const seen = new Set<string>();
  const models = { ...defaults };
  let invalidEntries = 0;
  for (const value of entries) {
    if (!isFusionEntry(value)) continue;
    const entry = object(value);
    if (typeof entry.id === "string" && typeof entry.timestamp === "string") {
      const key = JSON.stringify([entry.id, entry.timestamp]);
      if (seen.has(key)) continue;
      seen.add(key);
    }
    const data = object(entry.data);
    if (entry.customType === "fusion.models") {
      if (typeof data.leadModel === "string" && data.leadModel) models.leadModel = data.leadModel;
      if (typeof data.sidekickModel === "string" && data.sidekickModel) models.sidekickModel = data.sidekickModel;
      continue;
    }
    const isSidekick = entry.customType === "fusion.sidekick_usage";
    if (!isSidekick && entry.customType !== "fusion.lead_usage") continue;
    const validCall = !isSidekick || (counter(data.call) && data.call > 0 && counter(data.turns)
      && (typeof data.callId === "string" && data.callId.length > 0 || typeof data.sessionId === "string"));
    if (typeof data.model !== "string" || !data.model.trim() || !usageOf(data) || !validCall) {
      invalidEntries++;
      const role = isSidekick ? sidekick : lead;
      role.cost = sumCosts([role.cost, { usd: null, knownUsd: 0, unknownReasons: ["invalid usage entries"] }]);
      continue;
    }
    if (isSidekick) {
      const key = typeof data.callId === "string" && data.callId
        ? JSON.stringify(["call", data.callId]) : JSON.stringify(["legacy", data.sessionId, data.call]);
      calls.set(key, data);
    } else addRecord(lead, data, false);
  }
  let incompleteCalls = 0;
  for (const data of calls.values()) {
    addRecord(sidekick, data, true);
    if (data.complete === false) incompleteCalls++;
  }
  if (!lead.models.length && models.leadModel) lead.models.push(models.leadModel);
  if (!sidekick.models.length && models.sidekickModel) sidekick.models.push(models.sidekickModel);
  return { lead, sidekick, total: sumCosts([lead.cost, sidekick.cost]), incompleteCalls, invalidEntries };
}
export function mergeCosts(summaries: readonly FusionCosts[]): FusionCosts {
  const role = (name: "lead" | "sidekick"): RoleCost => ({
    models: [...new Set(summaries.flatMap((summary) => summary[name].models))],
    usage: summaries.reduce((usage, summary) => addUsage(usage, summary[name].usage), emptyUsage()),
    turns: summaries.reduce((sum, summary) => sum + summary[name].turns, 0),
    calls: summaries.reduce((sum, summary) => sum + summary[name].calls, 0),
    cost: sumCosts(summaries.map((summary) => summary[name].cost)),
  });
  const lead = role("lead");
  const sidekick = role("sidekick");
  return { lead, sidekick, total: sumCosts([lead.cost, sidekick.cost]),
    incompleteCalls: summaries.reduce((sum, summary) => sum + summary.incompleteCalls, 0),
    invalidEntries: summaries.reduce((sum, summary) => sum + summary.invalidEntries, 0) };
}
export function totalTokens(usage: TokenUsage): number {
  return usage.input + usage.cachedInput + usage.cacheWrite + usage.output;
}
function dollars(value: number): string {
  return value > 0 && value < 0.000001 ? "<$0.000001" : `$${value.toFixed(6)}`;
}
export function formatCost(cost: CostTotal, compact = false): string {
  if (cost.usd !== null) return dollars(cost.usd);
  if (compact) return "unknown";
  return `unknown (${cost.unknownReasons.join("; ")})${cost.knownUsd > 0 ? `; known ${dollars(cost.knownUsd)}` : ""}`;
}
export function formatFusionCost(summary: FusionCosts): string {
  const role = (label: string, value: RoleCost, sidekick = false): string[] => {
    const usage = value.usage;
    const hit = cacheHitRate(usage);
    return [
      `${label}: uncached input ${usage.input}, cached input ${usage.cachedInput}, cache write ${usage.cacheWrite}, output ${usage.output}`,
      `  Cache hit rate: ${hit === null ? "n/a" : `${(hit * 100).toFixed(2)}%`}; turns: ${value.turns}${sidekick ? `; calls: ${value.calls}` : ""}; USD: ${formatCost(value.cost)}`,
    ];
  };
  return [
    "Fusion cost (recorded session usage)",
    `Lead model: ${summary.lead.models.join(", ") || "not used"}`,
    `Sidekick model: ${summary.sidekick.models.join(", ") || "not used"}`,
    ...role("Lead", summary.lead), ...role("Sidekick", summary.sidekick, true),
    `Total USD: ${formatCost(summary.total)}`,
    ...(summary.incompleteCalls ? [`${summary.incompleteCalls} sidekick call(s) have no final snapshot; recorded usage may be incomplete.`] : []),
    ...(summary.invalidEntries ? [`Ignored ${summary.invalidEntries} invalid usage entry/entries.`] : []),
    "Configured-rate estimates from Pi usage.cost, not a bill.",
  ].join("\n");
}
export function formatFusionStatus(summary: FusionCosts): string {
  return `fusion: lead ${formatCost(summary.lead.cost, true)} · sidekick ${formatCost(summary.sidekick.cost, true)}`;
}
