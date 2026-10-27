import type { EvalConfig } from "./types.ts";

/** Exact provider/model IDs, checked separately with the isolated `pi --list-models`. */
export const configs: EvalConfig[] = [
  { id: "sol-solo", lead: "magpie/codex/gpt-6.1-sol" },
  {
    id: "fusion-sol+swe2",
    lead: "magpie/codex/gpt-6.1-sol",
    sidekick: "magpie/devin/swe-2",
  },
  {
    id: "fusion-sol+glm",
    lead: "magpie/codex/gpt-6.1-sol",
    sidekick: "magpie/zcode/GLM-5.3",
  },
  { id: "glm-solo", lead: "magpie/zcode/GLM-5.3" },
];

export function selectConfigs(selection?: string): EvalConfig[] {
  const ids = selection === undefined ? configs.map((config) => config.id) : selection.split(",");
  if (ids.length === 0 || ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    throw new Error("Configurations must be a nonempty list without duplicates");
  }
  return ids.map((id) => {
    const config = configs.find((candidate) => candidate.id === id);
    if (!config) throw new Error(`Unknown configuration: ${id}`);
    if (!/^[a-z0-9][a-z0-9+_-]*$/.test(config.id)) throw new Error("Invalid configuration ID");
    for (const model of [config.lead, config.sidekick].filter(Boolean) as string[]) {
      if (!/^[^/\s]+\/[^\s]+$/.test(model)) throw new Error("Expected provider/model");
    }
    return { ...config };
  });
}
