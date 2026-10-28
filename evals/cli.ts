import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { selectConfigs } from "./configs.ts";
import { localPath, ROOT } from "./files.ts";
import { createRedactor } from "./isolation.ts";
import { ratesForModel, validatePricing } from "./metrics.ts";
import { runEvaluation } from "./runner.ts";
import { loadTasks } from "./tasks.ts";

try {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean" }, configs: { type: "string" }, tasks: { type: "string" },
      repeats: { type: "string", default: "1" }, out: { type: "string" },
      "timeout-seconds": { type: "string", default: "300" }, help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log("pnpm eval --dry-run\npnpm eval --configs <a,b> --tasks 'evals/tasks/*' --repeats N --out results/<name> [--timeout-seconds 300]");
    console.log("Set model IDs in evals/models.local.json (copy evals/models.example.json). Find IDs with pi --list-models.");
  } else {
    const repeats = Number(values.repeats);
    const timeoutMs = Number(values["timeout-seconds"]) * 1000;
    if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 1000) throw new Error("repeats must be an integer in 1..1000");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3_600_000) {
      throw new Error("timeout-seconds must be in 1..3600");
    }
    const tasks = loadTasks(values.tasks);
    const configs = selectConfigs(values.configs);
    const pricing = validatePricing(JSON.parse(readFileSync(join(ROOT, "evals/pricing.json"), "utf8")));
    if (values["dry-run"]) {
      console.log(`Validated ${tasks.length} tasks, ${configs.length} configurations; ${tasks.length * configs.length * repeats} planned runs. No model calls.`);
      for (const task of tasks) console.log(`  ${task.id} [${task.type}] ${task.testCount} hidden tests`);
      for (const config of configs) console.log(`  ${config.id}: ${config.lead}${config.sidekick ? ` + ${config.sidekick}` : ""}`);
      const unknown = configs.flatMap((config) => [config.lead, config.sidekick].filter(Boolean) as string[])
        .filter((model) => {
          const rates = ratesForModel(pricing, model);
          return !rates || Object.values(rates).includes(null);
        });
      if (unknown.length) console.log(`  Pricing incomplete: ${[...new Set(unknown)].join(", ")} (reported as unknown, not free)`);
    } else {
      const out = localPath(values.out ?? `results/${new Date().toISOString().replace(/[:.]/g, "-")}`);
      mkdirSync(localPath(dirname(out)), { recursive: true });
      const rows = await runEvaluation({ tasks, configs, repeats, out, pricing, timeoutMs });
      console.log(`Saved ${rows.length} records and report: ${out}/report.md`);
      if (rows.some((row) => row.status !== "completed" || !row.passed)) process.exitCode = 1;
    }
  }
} catch (error) {
  console.error(createRedactor()(error instanceof Error ? error.message : "Evaluation failed"));
  process.exitCode = 1;
}
