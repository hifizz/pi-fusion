import { existsSync, globSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { assertRegularTree, copyTree, localPath, makeWorkspace, ROOT } from "./files.ts";
import { localEnvironment, sandboxCommand } from "./isolation.ts";
import { object } from "./metrics.ts";
import { runProcess } from "./process.ts";
import type { EvalTask, HiddenTestResult, TaskType } from "./types.ts";

export function loadTasks(pattern = "evals/tasks/*"): EvalTask[] {
  const directories = new Set(globSync(pattern, { cwd: ROOT }).map((path) => {
    const full = resolve(ROOT, path);
    return basename(full) === "task.md" ? resolve(full, "..") : full;
  }));
  if (directories.size === 0) throw new Error("Task glob matched no tasks");
  const tasks = [...directories].sort().map((directory) => {
    localPath(directory);
    if (!relative(join(ROOT, "evals/tasks"), directory).match(/^[^./][^/]*$/)) {
      throw new Error("Task glob must select evals/tasks/<id> directories or their task.md files");
    }
    assertRegularTree(directory);
    const manifest = object(JSON.parse(readFileSync(join(directory, "task.json"), "utf8")));
    if (manifest.id !== basename(directory) || !/^[a-z0-9-]+$/.test(String(manifest.id))) {
      throw new Error("Task ID must match its directory");
    }
    if (!["short", "medium", "bugfix", "refactor"].includes(String(manifest.type))
      || typeof manifest.description !== "string" || !manifest.description.trim()
      || !Number.isSafeInteger(manifest.testCount) || (manifest.testCount as number) < 1) {
      throw new Error(`Invalid task metadata: ${String(manifest.id)}`);
    }
    if (!readFileSync(join(directory, "task.md"), "utf8").trim()) throw new Error("Empty task prompt");
    for (const part of ["template/src", "reference/src", "hidden"]) {
      if (!existsSync(join(directory, part))) throw new Error(`Missing ${part} in ${String(manifest.id)}`);
    }
    for (const forbidden of [".hidden", "hidden", "reference", "node_modules", ".git"]) {
      if (existsSync(join(directory, "template", forbidden))) throw new Error("Template contains private/generated files");
    }
    if (!readdirSync(join(directory, "hidden")).some((name) => name.endsWith(".test.mjs"))) {
      throw new Error("No hidden test file");
    }
    return {
      id: manifest.id as string, type: manifest.type as TaskType,
      description: manifest.description as string, testCount: manifest.testCount as number, directory,
    };
  });
  return tasks;
}

export function copyTemplate(task: EvalTask, destination: string): void {
  copyTree(join(task.directory, "template"), destination);
}

export function copyHiddenTests(task: EvalTask, destination: string, agentHasExited: boolean): void {
  if (!agentHasExited) throw new Error("Hidden tests cannot be installed while the agent is running");
  if (existsSync(join(destination, ".hidden"))) throw new Error("Hidden test destination already exists");
  copyTree(join(task.directory, "hidden"), join(destination, ".hidden"));
}

export function parseTap(
  text: string, expected: number, exitCode: number | null, timedOut: boolean,
): HiddenTestResult {
  const value = (name: string) => {
    const matches = [...text.matchAll(new RegExp(`^# ${name} (\\d+)\\s*$`, "gm"))];
    return matches.length ? Number(matches.at(-1)![1]) : 0;
  };
  const total = value("tests");
  const passed = value("pass");
  const failed = value("fail");
  const skipped = value("skipped") + value("todo");
  const cancelled = value("cancelled");
  const allPassed = exitCode === 0 && !timedOut && total === expected && passed === expected
    && failed === 0 && skipped === 0 && cancelled === 0;
  return {
    expected, total, passed, failed, skipped, cancelled, allPassed, exitCode, timedOut,
    ratio: total <= expected ? Math.min(1, passed / expected) : 0,
  };
}

export async function gradeTask(task: EvalTask, source: string): Promise<{
  result: HiddenTestResult; output: string; durationMs: number;
}> {
  // A distinct directory is inaccessible even to a stray process from the model run.
  const workspace = makeWorkspace("grade-");
  try {
    const repository = join(workspace, "repo");
    copyTree(source, repository, new Set([".git", "node_modules", ".hidden", ".pi"]));
    copyHiddenTests(task, repository, true);
    const tests = readdirSync(join(repository, ".hidden"))
      .filter((name) => name.endsWith(".test.mjs")).sort()
      .map((name) => join(".hidden", name));
    const invocation = sandboxCommand(workspace, process.execPath,
      ["--test", "--test-reporter=tap", "--test-timeout=20000", ...tests]);
    const processResult = await runProcess(invocation.command, invocation.args, {
      cwd: repository, env: localEnvironment(workspace), timeoutMs: 30_000, maxOutputBytes: 2 * 1024 * 1024,
    });
    return {
      result: parseTap(processResult.stdout, task.testCount, processResult.exitCode,
        processResult.timedOut || processResult.outputLimited),
      output: processResult.stdout + processResult.stderr, durationMs: processResult.durationMs,
    };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}
