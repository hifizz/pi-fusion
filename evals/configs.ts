import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./files.ts";
import type { EvalConfig } from "./types.ts";

/** Model keys are resolved through the ignored local file, never a private provider default. */
const configs: EvalConfig[] = [
  { id: "sol-solo", lead: "gpt-6.1-sol" },
  {
    id: "fusion-sol+swe2",
    lead: "gpt-6.1-sol",
    sidekick: "swe-2",
  },
  {
    id: "fusion-sol+glm",
    lead: "gpt-6.1-sol",
    sidekick: "GLM-5.3",
  },
  { id: "glm-solo", lead: "GLM-5.3" },
];

export function selectConfigs(
  selection?: string,
  modelsPath = join(ROOT, "evals/models.local.json"),
): EvalConfig[] {
  const ids = selection === undefined ? configs.map((config) => config.id) : selection.split(",");
  if (ids.length === 0 || ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    throw new Error("Configurations must be a nonempty list without duplicates");
  }
  const selected = ids.map((id) => {
    const config = configs.find((candidate) => candidate.id === id);
    if (!config) throw new Error(`Unknown configuration: ${id}`);
    if (!/^[a-z0-9][a-z0-9+_-]*$/.test(config.id)) throw new Error("Invalid configuration ID");
    return config;
  });
  const setup = "Copy evals/models.example.json to evals/models.local.json and set model IDs from pi --list-models.";
  let models: unknown;
  try {
    models = JSON.parse(readFileSync(modelsPath, "utf8"));
  } catch {
    throw new Error(`Cannot load evaluation models from ${modelsPath}. ${setup}`);
  }
  if (models === null || typeof models !== "object" || Array.isArray(models)) {
    throw new Error(`Evaluation models must be a JSON object mapping model keys to provider/model IDs. ${setup}`);
  }
  const resolveModel = (key: string): string => {
    const model = (models as Record<string, unknown>)[key];
    if (typeof model !== "string" || !/^[^/\s<>]+\/[^\s<>]+$/.test(model)) {
      throw new Error(`Model "${key}" needs a provider/model ID without placeholders in ${modelsPath}. ${setup}`);
    }
    return model;
  };
  return selected.map((config) => ({
    id: config.id,
    lead: resolveModel(config.lead),
    ...(config.sidekick ? { sidekick: resolveModel(config.sidekick) } : {}),
  }));
}
