import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import { copyTemplate, gradeTask, parseTap } from "./tasks.ts";
import { localPath, makeWorkspace, ROOT } from "./files.ts";
import {
  createRedactor, globalPiFingerprint, localEnvironment, PI_CLI, safeEventLog,
  sandboxCommand, stagePiConfig,
} from "./isolation.ts";
import { collectMetrics, estimateCost, object, parsePiEvents } from "./metrics.ts";
import { evaluationPrompt } from "./prompts.ts";
import { runProcess } from "./process.ts";
import { writeReport } from "./report.ts";
import type { DiffSize, EvalConfig, EvalTask, Pricing, RunRecord } from "./types.ts";

const resourceFlags = [
  "--offline", "--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates",
  "--no-themes", "--no-context-files", "--no-approve",
];

async function git(repository: string, env: NodeJS.ProcessEnv, args: string[]): Promise<string> {
  const result = await runProcess("git",
    ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
    { cwd: repository, env, timeoutMs: 15_000, maxOutputBytes: 8 * 1024 * 1024 });
  if (result.exitCode !== 0 || result.timedOut || result.outputLimited) {
    throw new Error(`Git ${args[0]} failed; no command output was logged`);
  }
  return result.stdout;
}

export function diffSize(numstat: string, patch: string): DiffSize {
  let files = 0;
  let insertions = 0;
  let deletions = 0;
  // -z protects filenames with tabs/newlines; --no-renames makes each entry a single path.
  for (const entry of numstat.split("\0").filter(Boolean)) {
    const [added, removed] = entry.split("\t");
    if (!/^(?:\d+|-)$/.test(added) || !/^(?:\d+|-)$/.test(removed)) throw new Error("Invalid git numstat");
    files++;
    if (added !== "-") insertions += Number(added);
    if (removed !== "-") deletions += Number(removed);
  }
  return { files, insertions, deletions, bytes: Buffer.byteLength(patch) };
}

export async function listModels(configs: EvalConfig[]): Promise<string> {
  const workspace = makeWorkspace("catalog-");
  try {
    const models = [...new Set(configs.flatMap((config) => [config.lead, config.sidekick].filter(Boolean) as string[]))];
    const { agentDir, redact } = stagePiConfig(workspace, models);
    const env = { ...localEnvironment(workspace), PI_CODING_AGENT_DIR: agentDir };
    const invocation = sandboxCommand(workspace, process.execPath, [PI_CLI, "--list-models", ...resourceFlags]);
    const result = await runProcess(invocation.command, invocation.args,
      { cwd: workspace, env, timeoutMs: 30_000, maxOutputBytes: 4 * 1024 * 1024 });
    if (result.exitCode !== 0 || result.timedOut) {
      throw new Error("Isolated pi --list-models failed; no model requests were made");
    }
    const catalog = result.stdout.replace(/\u001b\[[0-9;]*m/g, "");
    for (const model of models) {
      const split = model.indexOf("/");
      const provider = model.slice(0, split);
      const id = model.slice(split + 1);
      if (!catalog.split("\n").some((line) => {
        const fields = line.trim().split(/\s+/);
        return fields.includes(provider) && fields.includes(id);
      })) throw new Error(`Model not found in pi --list-models: ${model}`);
    }
    return redact(catalog);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

export async function runTrial(options: {
  task: EvalTask; config: EvalConfig; repeat: number; out: string;
  pricing: Pricing; timeoutMs: number; preflightError?: string;
}): Promise<RunRecord> {
  const { task, config, repeat, pricing } = options;
  const started = performance.now();
  const runId = `${task.id}__${config.id}__${repeat}`;
  const artifacts = localPath(join(options.out, runId));
  mkdirSync(artifacts, { recursive: false });
  const workspace = makeWorkspace("run-");
  const repository = join(workspace, "repo");
  let redact = createRedactor();
  const record: RunRecord = {
    schemaVersion: 1, runId, task: task.id, taskType: task.type, config: config.id, repeat,
    models: { lead: config.lead, ...(config.sidekick ? { sidekick: config.sidekick } : {}) },
    startedAt: new Date().toISOString(), status: "infrastructure_error", exitCode: null,
    passed: false, wallTimeMs: 0, gradingTimeMs: 0, totalTimeMs: 0,
    hiddenTests: parseTap("", task.testCount, null, false),
    metrics: collectMetrics([]), cost: { leadUsd: 0, sidekickUsd: 0, totalUsd: null, knownUsd: 0, complete: false },
    diff: { files: 0, insertions: 0, deletions: 0, bytes: 0 },
    artifacts: relative(options.out, artifacts),
  };
  try {
    if (options.preflightError) throw new Error(options.preflightError);
    copyTemplate(task, repository);
    const staged = stagePiConfig(workspace, [config.lead, ...(config.sidekick ? [config.sidekick] : [])]);
    redact = staged.redact;
    const env = {
      ...localEnvironment(workspace), PI_CODING_AGENT_DIR: staged.agentDir,
      ...(config.sidekick ? { FUSION_SIDEKICK_MODEL: config.sidekick } : {}),
    };
    await git(repository, env, ["-c", "init.templateDir=", "init", "--initial-branch=main"]);
    await git(repository, env, ["add", "--", "."]);
    await git(repository, env, ["-c", "user.name=pi-fusion", "-c", "user.email=eval@pi-fusion.invalid",
      "commit", "--quiet", "--no-verify", "-m", "Evaluation template"]);
    const baseline = (await git(repository, env, ["rev-parse", "HEAD"])).trim();
    const prompt = evaluationPrompt(readFileSync(join(task.directory, "task.md"), "utf8"));
    const args = [
      PI_CLI, "-p", "--mode", "json", "--model", config.lead, "--thinking", "medium",
      "--no-session", ...resourceFlags,
      "--tools", `read,bash,edit,write,grep,find,ls${config.sidekick ? ",sidekick" : ""}`,
      "-e", join(ROOT, "evals/telemetry.ts"),
      ...(config.sidekick ? ["-e", join(ROOT, "src/index.ts")] : []),
      prompt,
    ];
    writeFileSync(join(artifacts, "invocation.json"), JSON.stringify({
      executable: "pi", args: args.slice(1, -1), stdin: "/dev/null",
      timeoutMs: options.timeoutMs, sandbox: "macOS Seatbelt", baseline,
      cwd: "<fresh private workspace>/repo",
    }, null, 2) + "\n");
    const invocation = sandboxCommand(workspace, process.execPath, args);
    const result = await runProcess(invocation.command, invocation.args, {
      cwd: repository, env, timeoutMs: options.timeoutMs,
    });
    record.exitCode = result.exitCode;
    record.wallTimeMs = result.durationMs;
    const { events, warnings } = parsePiEvents(result.stdout);
    if (result.timedOut) warnings.push("Timeout: observed token usage is a lower bound");
    if (result.outputLimited) warnings.push("Output limit reached: observed token usage is a lower bound");
    const modelError = events.some((event) => {
      const message = object(event.message);
      return event.type === "message_end" && message.role === "assistant"
        && ["error", "aborted"].includes(String(message.stopReason));
    });
    if (modelError) warnings.push("Model error/abort: reported usage may omit billed tokens");
    record.metrics = collectMetrics(events, warnings);
    record.status = result.timedOut ? "timeout"
      : result.exitCode === 0 && !result.outputLimited && !modelError ? "completed" : "agent_error";
    if (record.metrics.observedLeadModels.some((model) => model !== config.lead)
      || record.metrics.observedSidekickModels.some((model) => model !== config.sidekick)) {
      record.status = "agent_error";
      record.metrics.usageComplete = false;
      record.metrics.warnings.push("Observed model differs from requested configuration; cost is incomplete");
    }
    writeFileSync(join(artifacts, "events.jsonl"), safeEventLog(events, redact));
    writeFileSync(join(artifacts, "stderr.log"), redact(result.stderr));
    // Include new files, regardless of whether the agent staged them.
    await git(repository, env, ["add", "--intent-to-add", "--", "."]);
    const patch = await git(repository, env, ["diff", "--no-ext-diff", "--no-renames", "--no-color", baseline, "--", "."]);
    const stats = await git(repository, env, ["diff", "--no-ext-diff", "--no-renames", "--numstat", "-z", baseline, "--", "."]);
    record.diff = diffSize(stats, patch);
    writeFileSync(join(artifacts, "diff.patch"), redact(patch));
    const graded = await gradeTask(task, repository);
    record.hiddenTests = graded.result;
    record.gradingTimeMs = graded.durationMs;
    record.passed = graded.result.allPassed;
    writeFileSync(join(artifacts, "hidden-tests.tap"), redact(graded.output));
  } catch (error) {
    record.status = "infrastructure_error";
    record.error = redact(error instanceof Error ? error.message : "Evaluation infrastructure failed");
  } finally {
    record.cost = estimateCost(config, record.metrics, pricing);
    record.totalTimeMs = Math.round(performance.now() - started);
    // Delete cloned credentials and workspaces even when the model/grader fails.
    rmSync(workspace, { recursive: true, force: true });
    writeFileSync(join(artifacts, "result.json"), JSON.stringify(record, null, 2) + "\n");
  }
  return record;
}

export async function runEvaluation(options: {
  tasks: EvalTask[]; configs: EvalConfig[]; repeats: number; out: string; pricing: Pricing; timeoutMs: number;
}): Promise<RunRecord[]> {
  const out = localPath(options.out);
  // Exclusive creation makes an accidental rerun/overwrite fail before any model call.
  mkdirSync(out, { recursive: false });
  const before = globalPiFingerprint();
  const rows: RunRecord[] = [];
  writeFileSync(join(out, "pricing.json"), JSON.stringify(options.pricing, null, 2) + "\n");
  writeFileSync(join(out, "manifest.json"), JSON.stringify({
    schemaVersion: 1, createdAt: new Date().toISOString(), nodeVersion: process.version,
    piVersion: "1.4.0", configs: options.configs,
    tasks: options.tasks.map(({ directory: _directory, ...task }) => task),
    repeats: options.repeats, timeoutMs: options.timeoutMs, thinking: "medium",
    automaticRetry: false, compaction: false, cacheWarming: false,
    order: "repeat, then sorted task; config order rotates by (task index + repeat - 1)",
    cacheCaveat: "Fresh conversations do not guarantee a cold provider cache; cross-run cache effects and time/order effects are uncontrolled.",
  }, null, 2) + "\n");
  let preflightError: string | undefined;
  try {
    try {
      writeFileSync(join(out, "models.txt"), await listModels(options.configs));
    } catch (error) {
      preflightError = createRedactor()(error instanceof Error ? error.message : "Model preflight failed");
      writeFileSync(join(out, "models.txt"), preflightError + "\n");
    }
    for (let repeat = 1; repeat <= options.repeats; repeat++) {
      for (let taskIndex = 0; taskIndex < options.tasks.length; taskIndex++) {
        const task = options.tasks[taskIndex];
        const offset = (taskIndex + repeat - 1) % options.configs.length;
        const configs = [...options.configs.slice(offset), ...options.configs.slice(0, offset)];
        for (const config of configs) {
          console.log(`Running ${task.id} / ${config.id} / repeat ${repeat}`);
          const row = await runTrial({ ...options, out, task, config, repeat, preflightError });
          rows.push(row);
          appendFileSync(join(out, "runs.jsonl"), JSON.stringify(row) + "\n");
          console.log(`  ${row.status}; hidden tests ${row.hiddenTests.passed}/${row.hiddenTests.expected}`);
        }
      }
    }
  } finally {
    const after = globalPiFingerprint();
    const unchanged = JSON.stringify(before) === JSON.stringify(after);
    writeFileSync(join(out, "config-integrity.json"), JSON.stringify({ before, after, unchanged }, null, 2) + "\n");
    if (rows.length) writeReport(out);
    if (!unchanged) throw new Error("Global Pi configuration fingerprint changed during evaluation");
  }
  return rows;
}
