import assert from "node:assert/strict";
import {
  existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { addUsage, cacheHitRate, emptyUsage, usageFromPi } from "../src/usage.ts";
import { selectConfigs } from "../evals/configs.ts";
import { copyTree, localPath, makeWorkspace, ROOT } from "../evals/files.ts";
import { createRedactor, localEnvironment, sandboxCommand, safeEventLog } from "../evals/isolation.ts";
import { collectMetrics, costForUsage, estimateCost, parseJsonl, parsePiEvents, ratesForModel, validatePricing } from "../evals/metrics.ts";
import { runProcess } from "../evals/process.ts";
import { aggregate, loadRunRecords, renderReport, summarize, writeReport } from "../evals/report.ts";
import { diffSize } from "../evals/runner.ts";
import { copyHiddenTests, copyTemplate, loadTasks, parseTap } from "../evals/tasks.ts";
import type { Pricing, RunRecord } from "../evals/types.ts";

const pricing: Pricing = {
  currency: "USD", unit: "per_million_tokens",
  models: {
    "test/lead": { input: 2, cachedInput: 0.1, cacheWrite: 2.5, output: 10, source: "test", asOf: "2026-10-28" },
    "test/worker": { input: 1, cachedInput: 0.05, cacheWrite: 1, output: 5, source: "test", asOf: "2026-10-28" },
  },
};
const entry = (customType: string, data: unknown) => ({
  type: "entry_appended", entry: { type: "custom", customType, data },
});
const usage = { input: 100, output: 20, cacheRead: 50, cacheWrite: 2, reasoning: 10, totalTokens: 172 };
const assistant = {
  type: "message_end",
  message: { role: "assistant", provider: "test", model: "lead", usage, stopReason: "stop" },
};

function row(config: string, repeat: number, passed: boolean, totalUsd: number): RunRecord {
  const metrics = collectMetrics([
    entry("fusion.telemetry_ready", { version: 1 }), assistant, { type: "agent_settled", aborted: false },
  ]);
  return {
    schemaVersion: 1, runId: `task-${config}-${repeat}`, task: "task", taskType: "medium", config, repeat,
    models: { lead: "test/lead", ...(config.startsWith("fusion-") ? { sidekick: "test/worker" } : {}) },
    startedAt: "2026-10-28T00:00:00.000Z", status: "completed", exitCode: 0, passed,
    wallTimeMs: 2000, gradingTimeMs: 5, totalTimeMs: 2100,
    hiddenTests: {
      expected: 2, total: 2, passed: passed ? 2 : 1, failed: passed ? 0 : 1,
      skipped: 0, cancelled: 0, ratio: passed ? 1 : 0.5,
      allPassed: passed, exitCode: passed ? 0 : 1, timedOut: false,
    },
    metrics, cost: { leadUsd: totalUsd, sidekickUsd: 0, totalUsd, knownUsd: totalUsd, complete: true },
    diff: { files: 1, insertions: 3, deletions: 2, bytes: 90 }, artifacts: `task-${config}-${repeat}`,
  };
}

test("strict JSONL splits LF/CRLF without breaking Unicode separators; malformed records are explicit", () => {
  const text = '{"type":"message_end","text":"a\u2028b\u2029c"}\r\n{"type":"agent_settled"}\n';
  assert.equal(parseJsonl(text).length, 2);
  assert.equal(parseJsonl(text)[0].text, "a\u2028b\u2029c");
  assert.throws(() => parseJsonl('{"ok":true}\n{"token":'), /line 2/);
  assert.throws(() => parseJsonl("[]"), /Invalid JSONL/);
  const partial = parsePiEvents('{"type":"turn_start"}\n{"type":');
  assert.equal(partial.events.length, 1);
  assert.equal(partial.warnings.length, 1);
});

test("usage, cache rate and price preserve independent cache/read/write buckets", () => {
  const tokens = usageFromPi(usage);
  assert.deepEqual(tokens, { input: 100, cachedInput: 50, cacheWrite: 2, output: 20 });
  assert.equal(cacheHitRate(tokens), 50 / 152);
  assert.equal(cacheHitRate(emptyUsage()), null);
  assert.deepEqual(addUsage(tokens, tokens), { input: 200, cachedInput: 100, cacheWrite: 4, output: 40 });
  assert.ok(Math.abs(costForUsage(tokens, pricing.models["test/lead"]).total! - 0.000410) < 1e-12);
  assert.equal(costForUsage(tokens).total, null);
  assert.equal(costForUsage(emptyUsage()).total, 0);
  assert.throws(() => usageFromPi({ input: -1 }), /Invalid token/);
  assert.throws(() => usageFromPi({ input: 1.5 }), /Invalid token/);
  assert.throws(() => validatePricing({ ...pricing, currency: "EUR" }), /USD/);
  assert.throws(() => validatePricing({
    ...pricing, models: { bad: { ...pricing.models["test/lead"], input: -1 } },
  }), /Invalid price/);
});

test("neutral prices support provider IDs, exact overrides, and unknown models", () => {
  const neutral: Pricing = {
    ...pricing,
    models: {
      "gpt-6.1-sol": pricing.models["test/lead"],
      "swe-2": { ...pricing.models["test/worker"], input: 0, cachedInput: 0, cacheWrite: 0, output: 0 },
    },
  };
  assert.equal(ratesForModel(neutral, "example/team/gpt-6.1-sol"), neutral.models["gpt-6.1-sol"]);
  assert.equal(ratesForModel(neutral, "gpt-6.1-sol"), neutral.models["gpt-6.1-sol"]);
  assert.equal(ratesForModel(neutral, "example/other"), undefined);
  const config = { id: "sol-solo", lead: "example/team/gpt-6.1-sol" };
  const metrics = collectMetrics([
    { ...assistant, message: { ...assistant.message, provider: "example", model: "team/gpt-6.1-sol" } },
    { type: "agent_settled" },
  ]);
  assert.ok(Math.abs(estimateCost(config, metrics, neutral).totalUsd! - 0.000410) < 1e-12);
  const overrides = { ...neutral, models: { ...neutral.models, [config.lead]: pricing.models["test/worker"] } };
  assert.equal(ratesForModel(overrides, config.lead), pricing.models["test/worker"]);
  assert.equal(estimateCost(config, metrics, overrides).totalUsd,
    costForUsage(metrics.lead.usage, pricing.models["test/worker"]).total);
  assert.equal(estimateCost({ ...config, lead: "example/other" }, {
    ...metrics, observedLeadModels: ["example/other"],
  }, neutral).totalUsd, null);
  for (const worker of ["swe-2", "example/team/swe-2"]) {
    const record = row("fusion-sol+swe2", 1, true, 1);
    record.models = { lead: config.lead, sidekick: worker };
    const report = renderReport([record], undefined, neutral);
    assert.ok(report.includes(`| ${config.lead} | 2 | 0.1 | 2.5 | 10 |`));
    assert.ok(report.includes(`| ${worker} | 0 | 0 | 0 | 0 |`));
    assert.match(report, /SWE-2 零价.*实际网关计费未验证/);
  }
});

test("only authoritative assistant messages and last per-call sidekick snapshots count", () => {
  const progress = (call: number, input: number, cachedInput: number) => entry("fusion.sidekick_usage", {
    sessionId: "persistent-worker", call, model: "test/worker",
    usage: { input, cachedInput, cacheWrite: 0, output: 3 },
    turns: 1, toolCalls: 2, writeToolCalls: 1,
  });
  const events = [
    entry("fusion.telemetry_ready", { version: 1 }),
    { type: "turn_start" }, assistant,
    { type: "message_update", usage }, { type: "turn_end", message: assistant.message },
    { type: "agent_end", messages: [assistant.message] },
    entry("fusion.lead_usage", { usage: usageFromPi(usage) }),
    { type: "tool_execution_start", toolName: "bash", toolCallId: "bash-1" },
    entry("fusion.lead_mutation", { toolCallId: "bash-1", changedFiles: ["src/a.ts"] }),
    { type: "tool_execution_start", toolName: "sidekick", toolCallId: "s1" },
    progress(1, 10, 5), progress(1, 20, 10),
    { type: "tool_execution_end", toolName: "sidekick", toolCallId: "s1", result: { usage } },
    { type: "tool_execution_start", toolName: "sidekick", toolCallId: "s2" },
    progress(2, 5, 8),
    { type: "tool_execution_end", toolName: "sidekick", toolCallId: "s2", result: { usage } },
    { type: "agent_settled", aborted: false },
  ];
  const metrics = collectMetrics(events);
  assert.deepEqual(metrics.lead.usage, { input: 100, cachedInput: 50, cacheWrite: 2, output: 20 });
  assert.deepEqual(metrics.sidekick.usage, { input: 25, cachedInput: 18, cacheWrite: 0, output: 6 });
  assert.equal(metrics.lead.turns, 1);
  assert.equal(metrics.lead.toolCalls, 3);
  assert.equal(metrics.sidekick.turns, 2);
  assert.equal(metrics.sidekick.toolCalls, 4);
  assert.equal(metrics.leadWriteCalls, 1);
  assert.equal(metrics.sidekickCalls, 2);
  assert.deepEqual(metrics.sidekickSessionIds, ["persistent-worker"]);
  assert.deepEqual(metrics.observedLeadModels, ["test/lead"]);
  assert.equal(metrics.usageComplete, true);
  const cost = estimateCost({ id: "pair", lead: "test/lead", sidekick: "test/worker" }, metrics, pricing);
  assert.ok(Math.abs(cost.totalUsd! - (0.000410 + (25 + 18 * 0.05 + 6 * 5) / 1e6)) < 1e-12);
  const mismatched = estimateCost({ id: "pair", lead: "test/lead", sidekick: "test/worker" },
    { ...metrics, observedLeadModels: ["unknown/model"] }, pricing);
  assert.equal(mismatched.leadUsd, null, "never price a silently changed model with the requested model's rate");
  const incomplete = collectMetrics([assistant, { type: "tool_execution_start", toolName: "sidekick", toolCallId: "unfinished" }]);
  assert.equal(incomplete.usageComplete, false);
  assert.equal(estimateCost({ id: "solo", lead: "test/lead" }, incomplete, pricing).totalUsd, null);
});

test("reports include failed spending, zero-solved cases, partial pass rates and paired comparisons", () => {
  const rows = [
    row("sol-solo", 1, true, 2), row("sol-solo", 2, false, 4),
    row("fusion-sol+swe2", 1, true, 1), row("fusion-sol+swe2", 2, false, 2),
  ];
  const summary = summarize(rows);
  assert.equal(summary.byConfig["sol-solo"].passRate, 0.5);
  assert.equal(summary.byConfig["sol-solo"].meanPartialPassRatio, 0.75);
  assert.equal(summary.byConfig["sol-solo"].meanCostUsd, 3);
  assert.equal(summary.byConfig["sol-solo"].costPerSolvedTaskUsd, 6);
  assert.equal(summary.byConfig["sol-solo"].meanWallTimeSeconds, 2);
  assert.equal(summary.byConfig["sol-solo"].lead.cacheHitRate, 50 / 152);
  assert.equal(summary.comparisons[0].meanCostDifferenceUsd, -1.5);
  assert.equal(summary.comparisons[0].passRateDifference, 0);
  assert.equal(summary.comparisons[0].costReduction, 0.5);
  assert.equal(aggregate([row("none", 1, false, 9)]).costPerSolvedTaskUsd, null);
  const unknown = row("unknown", 1, true, 2);
  unknown.cost = { ...unknown.cost, complete: false, totalUsd: null };
  assert.equal(aggregate([unknown]).meanCostUsd, null);
  assert.equal(aggregate([unknown]).meanKnownCostUsd, 2);
  const timedOut = { ...unknown, config: "fusion-sol+swe2", status: "timeout" as const };
  const partial = summarize([row("sol-solo", 1, true, 1), timedOut]);
  assert.match(partial.comparisons[0].conclusion, /成本下界.*没有显示成本优势/);
  assert.match(renderReport([row("sol-solo", 1, true, 1), timedOut], partial), /≥\$2\.000000/);
  const unmatched = { ...row("fusion-sol+swe2", 1, true, 100), task: "different-task" };
  assert.equal(summarize([...rows, unmatched]).comparisons[0].pairedRuns, 2);
  assert.equal(summarize([...rows, unmatched]).comparisons[0].meanCostDifferenceUsd, -1.5);
  assert.throws(() => summarize([rows[0], rows[0]]), /Duplicate/);
  const report = renderReport(rows, summary);
  for (const required of ["置信度不足", "cached input", "sidekick", "每个通过任务成本", "按任务类型", "平均成本差"]) {
    assert.ok(report.includes(required));
  }
  const worse = summarize([row("sol-solo", 1, true, 2), row("fusion-sol+swe2", 1, true, 4)]);
  assert.match(worse.comparisons[0].conclusion, /没有显示.*优势/);
});

test("JSONL records round-trip to report.md and summary.json", (t) => {
  const workspace = makeWorkspace("report-test-");
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const records = [row("sol-solo", 1, true, 2), row("fusion-sol+swe2", 1, true, 1)];
  const text = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
  assert.deepEqual(loadRunRecords(text), records);
  assert.throws(() => loadRunRecords('{"schemaVersion":1}'), /Malformed/);
  writeFileSync(join(workspace, "runs.jsonl"), text);
  writeReport(workspace);
  assert.equal(JSON.parse(readFileSync(join(workspace, "summary.json"), "utf8")).runCount, 2);
  assert.match(readFileSync(join(workspace, "report.md"), "utf8"), /客观结论/);
});

test("eight tasks cover the requested mix and configurations resolve explicit local models", (t) => {
  const tasks = loadTasks();
  assert.equal(tasks.length, 8);
  assert.deepEqual(Object.fromEntries(["short", "medium", "bugfix", "refactor"]
    .map((type) => [type, tasks.filter((task) => task.type === type).length])),
  { short: 2, medium: 3, bugfix: 2, refactor: 1 });
  const workspace = makeWorkspace("models-test-");
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const modelsPath = join(workspace, "models.json");
  assert.throws(() => selectConfigs(undefined, modelsPath), /Copy evals\/models\.example\.json/);
  writeFileSync(modelsPath, JSON.stringify({
    "gpt-6.1-sol": "example/team/lead", "swe-2": "example/worker", "GLM-5.3": "other/glm",
  }));
  assert.deepEqual(selectConfigs(undefined, modelsPath), [
    { id: "sol-solo", lead: "example/team/lead" },
    { id: "fusion-sol+swe2", lead: "example/team/lead", sidekick: "example/worker" },
    { id: "fusion-sol+glm", lead: "example/team/lead", sidekick: "other/glm" },
    { id: "glm-solo", lead: "other/glm" },
  ]);
  assert.throws(() => selectConfigs("sol-solo,sol-solo", modelsPath), /duplicates/);
  assert.throws(() => selectConfigs("unknown", modelsPath), /Unknown/);
  writeFileSync(modelsPath, JSON.stringify({ "gpt-6.1-sol": "example/team/lead" }));
  assert.deepEqual(selectConfigs("sol-solo", modelsPath), [{ id: "sol-solo", lead: "example/team/lead" }]);
  assert.throws(() => selectConfigs("fusion-sol+swe2", modelsPath), /swe-2.*provider\/model/);
  for (const invalid of ["", "no-provider", "<provider>/model", "example/<model>", "example/model name", 42]) {
    writeFileSync(modelsPath, JSON.stringify({ "gpt-6.1-sol": invalid }));
    assert.throws(() => selectConfigs("sol-solo", modelsPath), /provider\/model ID without placeholders/);
  }
  for (const invalid of ["{", "[]", "null"]) {
    writeFileSync(modelsPath, invalid);
    assert.throws(() => selectConfigs(undefined, modelsPath), /Copy evals\/models\.example\.json/);
  }
  assert.throws(() => selectConfigs(undefined, join(ROOT, "evals/models.example.json")), /swe-2.*placeholders/);
  assert.throws(() => loadTasks("evals/tasks/missing*"), /no tasks/);
});

test("each workspace is independent; hidden tests are copied only after agent exit", (t) => {
  const [task] = loadTasks("evals/tasks/03-issue-summary");
  const first = makeWorkspace("fixture-test-"), second = makeWorkspace("fixture-test-");
  t.after(() => { rmSync(first, { recursive: true, force: true }); rmSync(second, { recursive: true, force: true }); });
  assert.notEqual(first, second);
  copyTemplate(task, first);
  copyTemplate(task, second);
  assert.equal(existsSync(join(first, ".hidden")), false);
  assert.equal(existsSync(join(first, "reference")), false);
  assert.throws(() => copyHiddenTests(task, first, false), /agent is running/);
  assert.equal(existsSync(join(first, ".hidden")), false);
  copyHiddenTests(task, first, true);
  assert.equal(existsSync(join(first, ".hidden/issues.test.mjs")), true);
  assert.equal(existsSync(join(second, ".hidden")), false);
  writeFileSync(join(first, "src/filter.ts"), "changed");
  assert.notEqual(readFileSync(join(first, "src/filter.ts"), "utf8"), readFileSync(join(second, "src/filter.ts"), "utf8"));
});

test("workspace copying and output paths reject symlink escapes", (t) => {
  const workspace = makeWorkspace("path-test-");
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  symlinkSync("/tmp", join(workspace, "escape"));
  assert.throws(() => localPath(join(workspace, "escape/output")), /inside pi-fusion/);
  assert.throws(() => copyTree(join(workspace, "escape"), join(workspace, "copy")), /Symlinks/);
  assert.throws(() => localPath("../outside"), /inside pi-fusion/);
});

test("hidden test results require expected count, no skips, and successful process exit", () => {
  const passed = "# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n";
  assert.equal(parseTap(passed, 2, 0, false).allPassed, true);
  assert.equal(parseTap(passed, 3, 0, false).allPassed, false);
  assert.equal(parseTap(passed, 2, 1, false).allPassed, false);
  assert.equal(parseTap(passed, 2, 0, true).allPassed, false);
  assert.equal(parseTap(passed.replace("# pass 2", "# pass 1").replace("# skipped 0", "# skipped 1"), 2, 0, false).allPassed, false);
  assert.equal(parseTap("# tests 2\n# pass 1\n# fail 1\n", 2, 1, false).ratio, 0.5);
  assert.equal(parseTap("", 2, 0, false).allPassed, false);
});

test("diff metrics handle binary and unusual filenames without line-splitting paths", () => {
  assert.deepEqual(diffSize("3\t1\tsrc/a.ts\0-\t-\timage\twith\nnewline.png\0", "patch"), {
    files: 2, insertions: 3, deletions: 1, bytes: 5,
  });
});

test("logs redact credential values and omit streamed text fragments", () => {
  const secret = "not-a-real-test-key-0123456789";
  const redact = createRedactor([{ key: secret }]);
  assert.equal(redact(`value=${secret}`), "value=[REDACTED]");
  const output = safeEventLog([
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: secret.slice(0, 12) } },
    { type: "message_end", message: { text: secret } },
  ], redact);
  assert.equal(output.includes(secret.slice(0, 12)), false);
  assert.match(output, /REDACTED/);
});

test("process timeout is bounded and stdin is EOF", async (t) => {
  const workspace = makeWorkspace("process-test-");
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const eof = await runProcess(process.execPath, ["-e", "process.stdin.resume();process.stdin.on('end',()=>console.log('EOF'))"], {
    cwd: workspace, env: localEnvironment(workspace), timeoutMs: 2_000,
  });
  assert.equal(eof.stdout.trim(), "EOF");
  assert.equal(eof.exitCode, 0);
  const timeout = await runProcess(process.execPath, ["-e", "setTimeout(()=>{},30000)"], {
    cwd: workspace, env: localEnvironment(workspace), timeoutMs: 100,
  });
  assert.equal(timeout.timedOut, true);
  assert.ok(timeout.durationMs < 2500);
});

test("Seatbelt hides upstream tests/references and other runs while allowing the current worktree", {
  skip: process.platform !== "darwin",
}, async (t) => {
  const workspace = makeWorkspace("sandbox-test-"), other = makeWorkspace("other-test-");
  t.after(() => { rmSync(workspace, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }); });
  mkdirSync(join(workspace, "repo"));
  writeFileSync(join(other, "private.txt"), "not visible");
  const forbidden = [
    join(ROOT, "evals/tasks/03-issue-summary/hidden/issues.test.mjs"),
    join(ROOT, "evals/tasks/03-issue-summary/reference/src/summary.ts"),
    join(other, "private.txt"),
  ];
  const script = `
    const fs=require('node:fs');
    for(const path of ${JSON.stringify(forbidden)}) {
      let denied=false;
      try { fs.readFileSync(path); } catch(error) { denied=['EPERM','EACCES'].includes(error.code); }
      if(!denied) throw Error('private path was readable');
    }
    let writeDenied=false;
    try { fs.writeFileSync(${JSON.stringify(join(other, "must-not-exist"))},'bad'); }
    catch(error){writeDenied=['EPERM','EACCES'].includes(error.code);}
    if(!writeDenied) throw Error('outside write was permitted');
    fs.writeFileSync('allowed.txt','ok');
    console.log('isolated');
  `;
  const invocation = sandboxCommand(workspace, process.execPath, ["-e", script]);
  const result = await runProcess(invocation.command, invocation.args, {
    cwd: join(workspace, "repo"), env: localEnvironment(workspace), timeoutMs: 5_000,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout.trim(), "isolated");
  assert.equal(existsSync(join(other, "must-not-exist")), false);
});

test("Pi 1.4 loads the actual TypeScript extension without a model request", {
  skip: process.platform !== "darwin",
}, async (t) => {
  const workspace = makeWorkspace("load-test-");
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  mkdirSync(join(workspace, "repo")); mkdirSync(join(workspace, "agent"));
  const script = `
    import {DefaultResourceLoader,SettingsManager} from ${JSON.stringify(join(ROOT, "node_modules/@earendil-works/pi-coding-agent/dist/index.js"))};
    const loader=new DefaultResourceLoader({
      cwd:${JSON.stringify(join(workspace, "repo"))},agentDir:${JSON.stringify(join(workspace, "agent"))},
      settingsManager:SettingsManager.inMemory(),noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,
      additionalExtensionPaths:[${JSON.stringify(join(ROOT, "src/index.ts"))}]
    });
    await loader.reload();
    const result=loader.getExtensions();
    if(result.errors.length) throw new Error(result.errors.map(e=>e.error).join(';'));
    if(!result.extensions.some(e=>e.tools.has('sidekick'))) throw new Error('sidekick not registered');
    console.log('sidekick loaded without inference');
  `;
  const invocation = sandboxCommand(workspace, process.execPath, ["--input-type=module", "-e", script]);
  const result = await runProcess(invocation.command, invocation.args, {
    cwd: join(workspace, "repo"), env: localEnvironment(workspace), timeoutMs: 15_000,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /sidekick loaded without inference/);
});

test('the actual sidekick SDK factory creates an isolated session without prompting', {
  skip: process.platform !== 'darwin',
}, async (t) => {
  const workspace = makeWorkspace('sdk-test-');
  t.after(() => rmSync(workspace, {recursive:true,force:true}));
  mkdirSync(join(workspace,'repo')); mkdirSync(join(workspace,'agent'));
  const agentDir = join(workspace,'agent');
  writeFileSync(join(agentDir,'models.json'), JSON.stringify({providers:{test:{
    baseUrl:'https://example.invalid/v1',api:'openai-completions',apiKey:'fake-offline-test-key',
    models:[{id:'worker',name:'Offline worker',reasoning:false,input:['text'],
      cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000,maxTokens:1024}]
  }}}), {mode:0o600});
  writeFileSync(join(agentDir,'auth.json'),'{}',{mode:0o600});
  const script = `
    import {createSidekickSession} from ${JSON.stringify(join(ROOT,'src/sidekick.ts'))};
    const session=await createSidekickSession({
      cwd:${JSON.stringify(join(workspace,'repo'))},
      modelRegistry:{getRegisteredNativeProvider:()=>undefined,getRegisteredProviderConfig:()=>undefined}
    },'test/worker');
    if(session.model?.id!=='worker'||session.messages.length!==0) throw new Error('Unexpected SDK session state');
    if(session.getActiveToolNames().includes('sidekick')) throw new Error('Recursive worker extension');
    session.dispose();
    console.log('worker initialized without inference');
  `;
  const invocation=sandboxCommand(workspace,process.execPath,['--input-type=module','-e',script]);
  const result=await runProcess(invocation.command,invocation.args,{
    cwd:join(workspace,'repo'),env:{...localEnvironment(workspace),PI_CODING_AGENT_DIR:agentDir},timeoutMs:15000,
  });
  assert.equal(result.exitCode,0,result.stderr);
  assert.match(result.stdout,/worker initialized without inference/);
});
