import type { TokenUsage } from "../src/usage.ts";

export type TaskType = "short" | "medium" | "bugfix" | "refactor";
export interface EvalTask {
  id: string;
  type: TaskType;
  description: string;
  testCount: number;
  directory: string;
}
export interface EvalConfig {
  id: string;
  lead: string;
  sidekick?: string;
}
export interface Rates {
  input: number | null;
  cachedInput: number | null;
  cacheWrite: number | null;
  output: number | null;
  source: string;
  asOf: string;
  note?: string;
}
export interface Pricing {
  currency: "USD";
  unit: "per_million_tokens";
  models: Record<string, Rates>;
}
export interface ModelMetrics {
  usage: TokenUsage;
  cacheHitRate: number | null;
  turns: number;
  toolCalls: number;
  writeToolCalls: number;
}
export interface Metrics {
  lead: ModelMetrics;
  sidekick: ModelMetrics;
  sidekickCalls: number;
  sidekickSessionIds: string[];
  leadWriteCalls: number | null;
  leadChangedFiles: string[];
  observedLeadModels: string[];
  observedSidekickModels: string[];
  usageComplete: boolean;
  warnings: string[];
}
export interface HiddenTestResult {
  expected: number;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  cancelled: number;
  ratio: number;
  allPassed: boolean;
  exitCode: number | null;
  timedOut: boolean;
}
export interface Cost {
  leadUsd: number | null;
  sidekickUsd: number | null;
  totalUsd: number | null;
  knownUsd: number;
  complete: boolean;
}
export interface DiffSize {
  files: number;
  insertions: number;
  deletions: number;
  bytes: number;
}
export interface RunRecord {
  schemaVersion: 1;
  runId: string;
  task: string;
  taskType: TaskType;
  config: string;
  repeat: number;
  models: { lead: string; sidekick?: string };
  startedAt: string;
  status: "completed" | "timeout" | "agent_error" | "infrastructure_error";
  error?: string;
  exitCode: number | null;
  passed: boolean;
  wallTimeMs: number;
  gradingTimeMs: number;
  totalTimeMs: number;
  hiddenTests: HiddenTestResult;
  metrics: Metrics;
  cost: Cost;
  diff: DiffSize;
  artifacts: string;
}
