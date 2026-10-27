import { writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { copyTree, localPath, makeWorkspace } from "./files.ts";
import { copyTemplate, gradeTask, loadTasks } from "./tasks.ts";

try {
  const rows = [];
  for (const task of loadTasks()) {
    const workspace = makeWorkspace("validate-");
    try {
      const original = join(workspace, "original");
      const reference = join(workspace, "reference");
      copyTemplate(task, original);
      copyTemplate(task, reference);
      copyTree(join(task.directory, "reference"), reference);
      const before = await gradeTask(task, original);
      const after = await gradeTask(task, reference);
      const valid = !before.result.allPassed && before.result.exitCode !== 0
        && !before.result.timedOut && after.result.allPassed;
      rows.push({ task: task.id, type: task.type, valid, template: before.result, reference: after.result });
      console.log(`${valid ? "PASS" : "FAIL"} ${task.id}: template ${before.result.passed}/${task.testCount}, reference ${after.result.passed}/${task.testCount}`);
      if (!valid) {
        // Only local fixture diagnostics; no credentials/model responses are involved.
        console.error(after.output.slice(-6000));
        process.exitCode = 1;
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }
  const cache = localPath(".cache");
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, "task-validation.json"), JSON.stringify(rows, null, 2) + "\n");
  console.log(`Validated ${rows.length} task pairs; no model calls.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Task validation failed");
  process.exitCode = 1;
}
