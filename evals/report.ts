import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addUsage, cacheHitRate, emptyUsage } from "../src/usage.ts";
import { localPath } from "./files.ts";
import { object, parseJsonl, validatePricing } from "./metrics.ts";
import type { Pricing, RunRecord } from "./types.ts";

export function aggregate(rows: RunRecord[]) {
  const passed = rows.filter((row) => row.passed).length;
  const complete = rows.every((row) => row.cost.complete && row.cost.totalUsd !== null);
  const totalCostUsd = complete ? rows.reduce((sum, row) => sum + row.cost.totalUsd!, 0) : null;
  const lead = rows.reduce((sum, row) => addUsage(sum, row.metrics.lead.usage), emptyUsage());
  const sidekick = rows.reduce((sum, row) => addUsage(sum, row.metrics.sidekick.usage), emptyUsage());
  const total = (pick: (row: RunRecord) => number) => rows.reduce((sum, row) => sum + pick(row), 0);
  return {
    runs: rows.length, uniqueTasks: new Set(rows.map((row) => row.task)).size,
    passed, passRate: rows.length ? passed / rows.length : 0,
    meanPartialPassRatio: rows.length ? total((row) => row.hiddenTests.ratio) / rows.length : 0,
    totalCostUsd, meanCostUsd: totalCostUsd === null || !rows.length ? null : totalCostUsd / rows.length,
    costPerSolvedTaskUsd: totalCostUsd === null || passed === 0 ? null : totalCostUsd / passed,
    knownCostUsd: total((row) => row.cost.knownUsd),
    meanKnownCostUsd: rows.length ? total((row) => row.cost.knownUsd) / rows.length : 0,
    knownCostPerSolvedTaskUsd: passed ? total((row) => row.cost.knownUsd) / passed : null,
    incompleteCostRuns: rows.filter((row) => !row.cost.complete).length,
    meanWallTimeSeconds: rows.length ? total((row) => row.wallTimeMs) / rows.length / 1000 : 0,
    errors: rows.filter((row) => row.status !== "completed").length,
    lead: { ...lead, cacheHitRate: cacheHitRate(lead) },
    sidekick: { ...sidekick, cacheHitRate: cacheHitRate(sidekick) },
    turns: { lead: total((row) => row.metrics.lead.turns), sidekick: total((row) => row.metrics.sidekick.turns) },
    toolCalls: {
      lead: total((row) => row.metrics.lead.toolCalls), sidekick: total((row) => row.metrics.sidekick.toolCalls),
    },
    leadWriteCalls: rows.every((row) => row.metrics.leadWriteCalls !== null)
      ? total((row) => row.metrics.leadWriteCalls!) : null,
    leadWriteToolCalls: total((row) => row.metrics.lead.writeToolCalls),
    sidekickCalls: total((row) => row.metrics.sidekickCalls),
    diff: {
      files: total((row) => row.diff.files), insertions: total((row) => row.diff.insertions),
      deletions: total((row) => row.diff.deletions), bytes: total((row) => row.diff.bytes),
    },
  };
}
type Aggregate = ReturnType<typeof aggregate>;

function grouped(rows: RunRecord[], key: (row: RunRecord) => string): Record<string, Aggregate> {
  return Object.fromEntries([...new Set(rows.map(key))].sort().map((name) => [
    name, aggregate(rows.filter((row) => key(row) === name)),
  ]));
}

export function summarize(rows: RunRecord[]) {
  if (rows.length === 0) throw new Error("Cannot report an empty evaluation");
  const keys = new Set<string>();
  for (const row of rows) {
    const key = `${row.config}\0${row.task}\0${row.repeat}`;
    if (keys.has(key)) throw new Error("Duplicate configuration/task/repeat in results");
    keys.add(key);
  }
  const byConfig = grouped(rows, (row) => row.config);
  const byTaskType = grouped(rows, (row) => `${row.taskType} / ${row.config}`);
  const baseline = new Map(rows.filter((row) => row.config === "sol-solo")
    .map((row) => [`${row.task}\0${row.repeat}`, row]));
  const comparisons = Object.keys(byConfig).filter((id) => id.startsWith("fusion-")).map((config) => {
    const paired = rows.filter((row) => row.config === config && baseline.has(`${row.task}\0${row.repeat}`));
    const base = aggregate(paired.map((row) => baseline.get(`${row.task}\0${row.repeat}`)!));
    const fusion = aggregate(paired);
    const meanCostDifferenceUsd = fusion.meanCostUsd !== null && base.meanCostUsd !== null
      ? fusion.meanCostUsd - base.meanCostUsd : null;
    const costReduction = base.meanCostUsd !== null && base.meanCostUsd > 0 && fusion.meanCostUsd !== null
      ? (base.meanCostUsd - fusion.meanCostUsd) / base.meanCostUsd : null;
    const passRateDifference = paired.length ? fusion.passRate - base.passRate : null;
    let conclusion: string;
    if (!paired.length) conclusion = "缺少相同任务与重复编号的 sol-solo 基线，不能比较。";
    else if (fusion.passed === 0 && base.passed === 0) conclusion = "两者均未解出任务，本样本没有显示 Fusion 的解题优势。";
    else if (fusion.meanCostUsd === null && base.meanCostUsd !== null && fusion.meanKnownCostUsd >= base.meanCostUsd) {
      conclusion = "Fusion 已记录的估算成本下界不低于基线，本样本没有显示成本优势；最终总成本仍不完整。";
    } else if (meanCostDifferenceUsd === null) conclusion = "成本或用量数据不完整，无法判断 Fusion 是否有成本优势。";
    else if (meanCostDifferenceUsd < 0 && passRateDifference! >= 0) {
      conclusion = "本样本观测到成本降低且通过率未下降；不能据此推断总体优势。";
    } else {
      conclusion = "本样本没有显示同时降低成本并保持通过率的优势。";
    }
    return { config, pairedRuns: paired.length, meanCostDifferenceUsd, costReduction,
      passRateDifference, conclusion };
  });
  return {
    schemaVersion: 1, generatedAt: new Date().toISOString(), runCount: rows.length,
    byConfig, byTaskType, comparisons,
    sampleWarning: "样本与任务覆盖有限，置信度不足。此报告描述固定小型任务的观测值，未做显著性检验；重复运行也不等于独立任务。不得外推生产任务表现。",
    methodology: {
      input: "Pi usage.input is uncached input; cached input and cache writes are separate.",
      cacheHitRate: "cachedInput / (input + cachedInput + cacheWrite); token-weighted, null if no input.",
      costPerSolvedTask: "All attempted-run costs, including failures, divided by passed task×repeat runs; null when none pass or any cost is unknown.",
      comparisons: "Paired on task ID and repeat number; cost difference is fusion minus sol-solo.",
      passRate: "All hidden tests pass, no skipped/cancelled tests, expected test count and successful grader exit. Agent status is reported separately.",
      time: "Wall time of the Pi process including model/tool work, excluding setup and grading.",
      leadWrites: "Successful write/edit calls plus bash calls with observed worktree content changes; excludes delegated sidekick mutations.",
    },
  };
}

const percent = (value: number | null) => value === null ? "—" : `${(value * 100).toFixed(1)}%`;
const dollars = (value: number | null) => value === null ? "—" : `$${value.toFixed(6)}`;
const costDisplay = (complete: number | null, known: number | null) =>
  complete !== null ? dollars(complete) : known !== null ? `≥${dollars(known)}` : "—";

export function renderReport(rows: RunRecord[], summary = summarize(rows), pricing?: Pricing): string {
  const lines = [
    "# pi-fusion 评测报告", "", `生成时间：${summary.generatedAt}`, "",
    `**${summary.sampleWarning}**`, "", "## 按配置汇总", "",
    "| 配置 | 通过 / 次数 | 通过率 | 部分测试平均通过率 | 平均估算成本 | 每个通过任务成本 | 平均时间 s | 运行异常 |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const [id, group] of Object.entries(summary.byConfig)) {
    lines.push(`| ${id} | ${group.passed}/${group.runs} | ${percent(group.passRate)} | ${percent(group.meanPartialPassRatio)} | ${costDisplay(group.meanCostUsd, group.meanKnownCostUsd)} | ${costDisplay(group.costPerSolvedTaskUsd, group.knownCostPerSolvedTaskUsd)} | ${group.meanWallTimeSeconds.toFixed(2)} | ${group.errors} |`);
  }
  lines.push("", "成本是 USD 估算，使用本次运行保存的 pricing.json；不是账单。费用缺失或中途终止导致用量不完整时用「≥」展示已记录且已定价部分的下界；未知部分不会当作免费。下界不是完整总额。",
    "每个通过任务成本 = 所有尝试（含失败）的总成本 / 通过的任务×重复次数；零通过时无定义。",
    "", "## 分模型用量", "",
    "| 配置 | 角色 | 非缓存 input | cached input | cache write | output（含推理） | 缓存命中率 | 回合 | 工具调用 |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const [id, group] of Object.entries(summary.byConfig)) {
    for (const role of ["lead", "sidekick"] as const) {
      const usage = group[role];
      lines.push(`| ${id} | ${role} | ${usage.input} | ${usage.cachedInput} | ${usage.cacheWrite} | ${usage.output} | ${percent(usage.cacheHitRate)} | ${group.turns[role]} | ${group.toolCalls[role]} |`);
    }
  }
  lines.push("", "缓存命中率按所有输入 token 加权；output 已含推理 token，不重复加计。只统计完成消息的用量，sidekick 使用每次调用的最后一份累计快照。",
    "", "## 委派与改动", "",
    "| 配置 | lead 写文件调用 | lead write/edit 调用（含尝试） | sidekick 调用 | diff 文件 / 增 / 删 |",
    "| --- | ---: | ---: | ---: | ---: |");
  for (const [id, group] of Object.entries(summary.byConfig)) {
    lines.push(`| ${id} | ${group.leadWriteCalls ?? "—"} | ${group.leadWriteToolCalls} | ${group.sidekickCalls} | ${group.diff.files} / +${group.diff.insertions} / -${group.diff.deletions} |`);
  }
  lines.push("", "lead 写文件调用包括成功的 write/edit 和实际改变工作树内容的 bash 调用；sidekick 的修改不计入 lead。它衡量调用次数，不是系统调用或写入行数。",
    "", "## 按任务类型分组", "",
    "| 类型 / 配置 | 通过 / 次数 | 通过率 | 平均估算成本 | 每个通过任务成本 | 平均时间 s |",
    "| --- | ---: | ---: | ---: | ---: | ---: |");
  for (const [id, group] of Object.entries(summary.byTaskType)) {
    lines.push(`| ${id} | ${group.passed}/${group.runs} | ${percent(group.passRate)} | ${costDisplay(group.meanCostUsd, group.meanKnownCostUsd)} | ${costDisplay(group.costPerSolvedTaskUsd, group.knownCostPerSolvedTaskUsd)} | ${group.meanWallTimeSeconds.toFixed(2)} |`);
  }
  lines.push("", "## Fusion 与 sol-solo 的配对比较", "",
    "| 配置 | 配对次数 | 平均成本差（Fusion − solo） | 成本降低比例 | 通过率差 |",
    "| --- | ---: | ---: | ---: | ---: |");
  for (const comparison of summary.comparisons) {
    lines.push(`| ${comparison.config} | ${comparison.pairedRuns} | ${dollars(comparison.meanCostDifferenceUsd)} | ${percent(comparison.costReduction)} | ${comparison.passRateDifference === null ? "—" : `${(comparison.passRateDifference * 100).toFixed(1)} 个百分点`} |`);
  }
  lines.push("", "仅比较任务 ID 和重复编号完全一致的运行；不把不同任务难度造成的差异算作 Fusion 效果。",
    "", "## 客观结论", "");
  if (!summary.comparisons.length) lines.push("未包含 Fusion 与 sol-solo 的配对样本，无法判断相对优势。");
  for (const comparison of summary.comparisons) lines.push(`- ${comparison.config}：${comparison.conclusion}`);
  lines.push("", summary.sampleWarning, "", "## 逐次运行", "",
    "| 任务 | 配置 | 重复 | 状态 | 隐藏测试 | 成本 | 证据 |",
    "| --- | --- | ---: | --- | ---: | ---: | --- |");
  for (const row of rows) {
    lines.push(`| ${row.task} | ${row.config} | ${row.repeat} | ${row.status} | ${row.hiddenTests.passed}/${row.hiddenTests.expected} | ${costDisplay(row.cost.totalUsd, row.cost.knownUsd)} | [日志与 diff](${row.artifacts}/) |`);
  }
  const warnings = [...new Set(rows.flatMap((row) => row.metrics.warnings))];
  if (warnings.length) lines.push("", "用量记录限制：", "", ...warnings.map((warning) => `- ${warning}`));
  if (pricing) {
    lines.push("", "## 价格依据与假设", "",
      "| 模型 | input | cached input | cache write | output | 日期 |",
      "| --- | ---: | ---: | ---: | ---: | --- |");
    const models = [...new Set(rows.flatMap((row) => [row.models.lead, row.models.sidekick].filter(Boolean) as string[]))];
    for (const model of models) {
      const rates = pricing.models[model];
      if (!rates) continue;
      lines.push(`| ${model} | ${rates.input ?? "未知"} | ${rates.cachedInput ?? "未知"} | ${rates.cacheWrite ?? "未知"} | ${rates.output ?? "未知"} | ${rates.asOf} |`);
    }
    lines.push("", "单价单位为 USD / 百万 token。");
    for (const model of models) {
      const rates = pricing.models[model];
      if (rates) lines.push("", `- ${model}：${rates.source}。${rates.note ?? ""}`);
    }
    if (models.includes("magpie/devin/swe-2")) lines.push("",
      "**SWE-2 零价只在网关沿用普通 Free 档时成立，实际网关计费未验证。本文的成本比较以保存的价格表为条件；它不能证明真实账单会等额下降。**");
  }
  lines.push("", "缓存与顺序限制：每次使用新会话，但无法清空供应商缓存；跨运行缓存、执行顺序和服务负载可能影响成本与时间。");
  lines.push("", "复现参数见 manifest.json；模型列表见 models.txt；全局 Pi 配置前后指纹见 config-integrity.json。", "");
  return lines.join("\n");
}

export function loadRunRecords(text: string): RunRecord[] {
  return parseJsonl(text).map((value) => {
    const requiredNumbers = ["repeat", "wallTimeMs", "gradingTimeMs", "totalTimeMs"];
    const hidden = object(value.hiddenTests);
    const metrics = object(value.metrics);
    const cost = object(value.cost);
    if (value.schemaVersion !== 1 || typeof value.runId !== "string"
      || typeof value.task !== "string" || typeof value.config !== "string"
      || !["short", "medium", "bugfix", "refactor"].includes(String(value.taskType))
      || !["completed", "timeout", "agent_error", "infrastructure_error"].includes(String(value.status))
      || requiredNumbers.some((key) => typeof value[key] !== "number"
        || !Number.isFinite(value[key]) || (value[key] as number) < 0)
      || typeof value.passed !== "boolean" || value.passed !== hidden.allPassed
      || typeof hidden.ratio !== "number" || hidden.ratio < 0 || hidden.ratio > 1
      || !metrics.lead || !metrics.sidekick || !Array.isArray(metrics.warnings)
      || typeof cost.complete !== "boolean" || typeof cost.knownUsd !== "number"
      || (cost.totalUsd !== null && (typeof cost.totalUsd !== "number" || cost.totalUsd < 0))
      || !value.diff || typeof value.artifacts !== "string") {
      throw new Error("Malformed evaluation record");
    }
    return value as unknown as RunRecord;
  });
}

export function writeReport(directory: string) {
  const path = localPath(directory);
  const rows = loadRunRecords(readFileSync(join(path, "runs.jsonl"), "utf8"));
  const summary = summarize(rows);
  writeFileSync(localPath(join(path, "summary.json")), JSON.stringify(summary, null, 2) + "\n");
  const pricingPath = join(path, "pricing.json");
  const pricing = existsSync(pricingPath) ? validatePricing(JSON.parse(readFileSync(pricingPath, "utf8"))) : undefined;
  writeFileSync(localPath(join(path, "report.md")), renderReport(rows, summary, pricing));
  return summary;
}
