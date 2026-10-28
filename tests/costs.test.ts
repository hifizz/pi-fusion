import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  aggregateCosts,
  captureCost,
  formatCost,
  formatFusionCost,
  formatFusionStatus,
  hasConfiguredRates,
  mergeCosts,
  recordedPiCost,
} from "../src/costs.ts";
import { defaultSessionsDir, summarizeSessions } from "../src/costs-cli.ts";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const FIXTURES = join(REPO_ROOT, "tests", "fixtures", "costs");
const MODELS_FIXTURE = join(REPO_ROOT, "tests", "fixtures", "cost-models.json");
const CLI = join(REPO_ROOT, "src", "costs-cli.ts");
const TEST_TMP_ROOT = join(REPO_ROOT, ".cache", "test-tmp");

function readEntries(file: string): unknown[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function fusionEntry(customType: string, data: Record<string, unknown>, id = `${customType}-${Math.random()}`) {
  return { type: "custom", customType, id, timestamp: "2026-10-26T10:00:00.000Z", data };
}

const KNOWN_ENTRIES = readEntries(join(FIXTURES, "known.jsonl"));
const UNKNOWN_ENTRIES = readEntries(join(FIXTURES, "nested", "unknown.jsonl"));

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const ZERO_RATES = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const KNOWN_COMMAND_TEXT = [
  "Fusion cost (recorded session usage)",
  "Lead model: example/lead",
  "Sidekick model: example/worker",
  "Lead: uncached input 1500, cached input 1500, cache write 100, output 300",
  "  Cache hit rate: 48.39%; turns: 2; USD: $0.006400",
  "Sidekick: uncached input 3100, cached input 600, cache write 50, output 310",
  "  Cache hit rate: 16.00%; turns: 3; calls: 2; USD: $0.004760",
  "Total USD: $0.011160",
  "Configured-rate estimates from Pi usage.cost, not a bill.",
].join("\n");

test("aggregates the known fixture: recorded costs verbatim, snapshots deduped, plain messages ignored", () => {
  const summary = aggregateCosts(KNOWN_ENTRIES);
  assert.deepEqual(summary.lead.models, ["example/lead"]);
  assert.deepEqual(summary.lead.usage, { input: 1500, cachedInput: 1500, cacheWrite: 100, output: 300 });
  assert.equal(summary.lead.turns, 2);
  assert.equal(summary.lead.calls, 0);
  assert.ok(Math.abs((summary.lead.cost.usd ?? NaN) - 0.0064) < 1e-12);
  assert.ok(Math.abs(summary.lead.cost.knownUsd - 0.0064) < 1e-12);
  assert.deepEqual(summary.lead.cost.unknownReasons, []);

  assert.deepEqual(summary.sidekick.models, ["example/worker"]);
  assert.deepEqual(summary.sidekick.usage, { input: 3100, cachedInput: 600, cacheWrite: 50, output: 310 });
  assert.equal(summary.sidekick.turns, 3);
  assert.equal(summary.sidekick.calls, 2);
  assert.ok(Math.abs((summary.sidekick.cost.usd ?? NaN) - 0.00476) < 1e-12);
  assert.ok(Math.abs((summary.total.usd ?? NaN) - 0.01116) < 1e-12);
  assert.equal(summary.incompleteCalls, 0);
  assert.equal(summary.invalidEntries, 0);
});

test("aggregates the unknown fixture: unpriced lead and legacy sidekick stay unknown", () => {
  const summary = aggregateCosts(UNKNOWN_ENTRIES);
  assert.deepEqual(summary.lead.usage, { input: 20, cachedInput: 10, cacheWrite: 0, output: 5 });
  assert.equal(summary.lead.cost.usd, null);
  assert.equal(summary.lead.cost.knownUsd, 0);
  assert.deepEqual(summary.lead.cost.unknownReasons, ["no rates configured"]);

  assert.deepEqual(summary.sidekick.usage, { input: 30, cachedInput: 5, cacheWrite: 0, output: 10 });
  assert.equal(summary.sidekick.calls, 1);
  assert.equal(summary.sidekick.cost.usd, null);
  assert.equal(summary.sidekick.cost.knownUsd, 0);
  assert.deepEqual(summary.sidekick.cost.unknownReasons, ["cost not recorded"]);

  assert.equal(summary.total.usd, null);
  assert.equal(summary.total.knownUsd, 0);
  assert.equal(summary.incompleteCalls, 0);
  assert.equal(summary.invalidEntries, 0);

  const merged = mergeCosts([aggregateCosts(KNOWN_ENTRIES), summary]);
  assert.equal(merged.total.usd, null);
  assert.ok(Math.abs(merged.total.knownUsd - 0.01116) < 1e-12);
});

test("hasConfiguredRates resolves positive, explicit-zero, and undeclared rates", () => {
  const model = (id: string, cost: unknown, provider = "example") =>
    ({ provider, id, cost }) as Parameters<typeof hasConfiguredRates>[0];

  assert.equal(hasConfiguredRates(model("any", { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }), undefined, MODELS_FIXTURE), true,
    "positive base rate");
  assert.equal(hasConfiguredRates(model("any", { ...ZERO_RATES, tiers: [{ input: 0.5, output: 0, cacheRead: 0, cacheWrite: 0, inputTokensAbove: 100 }] }), undefined, MODELS_FIXTURE), true,
    "positive tier rate");
  assert.equal(hasConfiguredRates(model("free", ZERO_RATES), undefined, MODELS_FIXTURE), true,
    "explicit zero model declaration means free");
  assert.equal(hasConfiguredRates(model("overridden", ZERO_RATES), undefined, MODELS_FIXTURE), true,
    "topmost modelOverrides zero means free");
  assert.equal(hasConfiguredRates(model("regfree", ZERO_RATES),
    { models: [{ id: "regfree", cost: { ...ZERO_RATES } }] }, MODELS_FIXTURE), true,
    "registered provider explicit zero means free");
  assert.equal(hasConfiguredRates(model("unpriced", ZERO_RATES), undefined, MODELS_FIXTURE), false,
    "all-zero runtime rates with no explicit declaration are unknown, not free");
  assert.equal(hasConfiguredRates(model("missing", ZERO_RATES), undefined, MODELS_FIXTURE), false,
    "absent from models.json is not evidence of free");
  assert.equal(hasConfiguredRates(model("free", {}), undefined, MODELS_FIXTURE), false,
    "missing runtime cost fields cannot prove rates");
  assert.equal(hasConfiguredRates(model("free", { input: -1, output: 0, cacheRead: 0, cacheWrite: 0 }), undefined, MODELS_FIXTURE), false,
    "negative runtime rates are invalid");
  assert.equal(hasConfiguredRates(undefined, undefined, MODELS_FIXTURE), false);
});

test("captureCost trusts positive recorded cost and otherwise needs rate evidence", () => {
  const usage = (cost: unknown) =>
    ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost }) as Parameters<typeof captureCost>[0];
  const positive = captureCost(usage({ ...ZERO_COST, input: 0.5, total: 0.5 }));
  assert.equal(positive.ratesConfigured, true, "positive recorded cost proves configured rates");
  assert.deepEqual(positive.cost, { ...ZERO_COST, input: 0.5, total: 0.5 });
  const rated = captureCost(usage(ZERO_COST), {
    provider: "example", id: "x", cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
  } as never);
  assert.equal(rated.ratesConfigured, true, "positive resolved model rates prove configured rates");
  const unrated = captureCost(usage(ZERO_COST));
  assert.equal(unrated.ratesConfigured, false, "zero recorded cost alone is not evidence");
  assert.equal(recordedPiCost({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), null, "incomplete cost shape is invalid");
});

test("sidekick call snapshots keep the last per call; legacy and callId identities both work", () => {
  const usage = (input: number) => ({ input, cachedInput: 0, cacheWrite: 0, output: 0 });
  const cost = (total: number) => ({ input: 0, output: total, cacheRead: 0, cacheWrite: 0, total });
  const worker = (data: Record<string, unknown>) => fusionEntry("fusion.sidekick_usage", {
    model: "example/worker", ratesConfigured: true, toolCalls: 0, writeToolCalls: 0, ...data,
  });

  const legacy = aggregateCosts([
    worker({ sessionId: "a", call: 1, usage: usage(10), cost: cost(1), turns: 1 }),
    worker({ sessionId: "b", call: 1, usage: usage(20), cost: cost(2), turns: 1 }),
  ]);
  assert.equal(legacy.sidekick.calls, 2, "same numeric call on different sessions is two calls");
  assert.equal(legacy.sidekick.usage.input, 30);

  const identified = aggregateCosts([
    worker({ sessionId: "", call: 1, callId: "id-a", usage: usage(10), cost: cost(1), turns: 1, complete: true }),
    worker({ sessionId: "", call: 1, callId: "id-b", usage: usage(20), cost: cost(2), turns: 1, complete: true }),
  ]);
  assert.equal(identified.sidekick.calls, 2, "distinct callIds on one call number are two calls");
  assert.equal(identified.sidekick.usage.input, 30);

  const cumulative = aggregateCosts([
    worker({ sessionId: "a", call: 1, callId: "same", usage: usage(10), cost: cost(1), turns: 1, complete: false }),
    worker({ sessionId: "a", call: 1, callId: "same", usage: usage(30), cost: cost(3), turns: 2, complete: true }),
  ]);
  assert.equal(cumulative.sidekick.calls, 1, "cumulative snapshots collapse to the last one");
  assert.equal(cumulative.sidekick.usage.input, 30);
  assert.equal(cumulative.sidekick.turns, 2);
  assert.equal(cumulative.incompleteCalls, 0);

  const unfinished = aggregateCosts([
    worker({ sessionId: "a", call: 1, callId: "open", usage: usage(10), cost: cost(1), turns: 1, complete: false }),
  ]);
  assert.equal(unfinished.incompleteCalls, 1, "a call with no final snapshot is flagged");

  const duplicated = aggregateCosts([
    fusionEntry("fusion.lead_usage", { model: "example/lead", usage: usage(5), cost: cost(1), ratesConfigured: true }, "same-id"),
    fusionEntry("fusion.lead_usage", { model: "example/lead", usage: usage(5), cost: cost(1), ratesConfigured: true }, "same-id"),
  ]);
  assert.equal(duplicated.lead.turns, 1, "same id+timestamp entry counts once");
});

test("invalid usage entries are skipped, counted, and mark cost unknown", () => {
  const usage = { input: 10, cachedInput: 0, cacheWrite: 0, output: 0 };
  const cost = { ...ZERO_COST, total: 1, output: 1 };
  const summary = aggregateCosts([
    fusionEntry("fusion.lead_usage", { model: "example/lead", usage: { ...usage, input: -1 }, cost, ratesConfigured: true }),
    fusionEntry("fusion.lead_usage", { model: "example/lead", usage: { ...usage, output: NaN }, cost, ratesConfigured: true }),
    fusionEntry("fusion.lead_usage", { model: "", usage, cost, ratesConfigured: true }),
    fusionEntry("fusion.sidekick_usage", { model: "example/worker", sessionId: "a", call: 1, turns: 1 }),
    fusionEntry("fusion.sidekick_usage", { model: "example/worker", usage, call: 1, turns: 1 }),
    fusionEntry("fusion.lead_usage", { model: "example/lead", usage, cost: { ...ZERO_COST, total: -1 }, ratesConfigured: true }),
  ]);
  assert.equal(summary.invalidEntries, 5);
  assert.equal(summary.lead.cost.usd, null);
  assert.ok(summary.lead.cost.unknownReasons.includes("invalid usage entries"));
  assert.equal(summary.sidekick.cost.usd, null);

  const badCost = aggregateCosts([
    fusionEntry("fusion.lead_usage", { model: "example/lead", usage, cost: { ...ZERO_COST, total: -1 }, ratesConfigured: true }),
  ]);
  assert.deepEqual(badCost.lead.cost.unknownReasons, ["invalid recorded cost"]);
});

test("fusion.models supplies fallback model names only", () => {
  const usage = { input: 1, cachedInput: 0, cacheWrite: 0, output: 0 };
  const withFallback = aggregateCosts([
    fusionEntry("fusion.models", { leadModel: "example/l", sidekickModel: "example/w" }),
  ]);
  assert.deepEqual(withFallback.lead.models, ["example/l"]);
  assert.deepEqual(withFallback.sidekick.models, ["example/w"]);
  const withRecorded = aggregateCosts([
    fusionEntry("fusion.models", { leadModel: "example/other" }),
    fusionEntry("fusion.lead_usage", { model: "example/lead", usage, cost: ZERO_COST, ratesConfigured: true }),
  ]);
  assert.deepEqual(withRecorded.lead.models, ["example/lead"], "recorded model wins over fallback");
});

test("formatFusionCost matches the exact known-fixture output", () => {
  assert.equal(formatFusionCost(aggregateCosts(KNOWN_ENTRIES)), KNOWN_COMMAND_TEXT);
});

test("formatters handle empty, unknown, and tiny costs", () => {
  const empty = aggregateCosts([]);
  const text = formatFusionCost(empty);
  assert.ok(text.includes("Lead model: not used"));
  assert.ok(text.includes("Cache hit rate: n/a"));
  assert.ok(text.includes("USD: $0.000000"));
  assert.equal(formatFusionStatus(aggregateCosts(KNOWN_ENTRIES)), "fusion: lead $0.006400 · sidekick $0.004760");
  assert.equal(formatFusionStatus(aggregateCosts(UNKNOWN_ENTRIES)), "fusion: lead unknown · sidekick unknown");
  assert.equal(formatCost({ usd: 1e-9, knownUsd: 1e-9, unknownReasons: [] }), "<$0.000001");
  assert.equal(formatCost({ usd: 0, knownUsd: 0, unknownReasons: [] }), "$0.000000");
  assert.equal(formatCost({ usd: null, knownUsd: 0, unknownReasons: ["cost not recorded"] }), "unknown (cost not recorded)");
  assert.equal(formatCost({ usd: null, knownUsd: 0.5, unknownReasons: ["no rates configured"] }), "unknown (no rates configured); known $0.500000");
  assert.equal(formatCost({ usd: null, knownUsd: 0, unknownReasons: [] }, true), "unknown");
});

function fixtureHashes(): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const file of ["known.jsonl", "unrelated.jsonl", "nested/unknown.jsonl"]) {
    const path = join(FIXTURES, file);
    hashes.set(file, createHash("sha256").update(readFileSync(path)).digest("hex"));
  }
  return hashes;
}

function runCli(args: string[]): { stdout: string; status: number; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { stdout, status: 0, stderr: "" };
  } catch (error) {
    const failed = error as { status?: number; stdout?: string; stderr?: string };
    return { stdout: String(failed.stdout ?? ""), status: failed.status ?? 1, stderr: String(failed.stderr ?? "") };
  }
}

test("CLI summarizes the fixture directory read-only, recursively", () => {
  const before = fixtureHashes();
  const { stdout, status } = runCli(["--dir", FIXTURES, "--json"]);
  assert.equal(status, 0);
  const result = JSON.parse(stdout);
  assert.equal(result.sessions.length, 2, "only sessions containing fusion entries appear");
  assert.deepEqual(result.sessions.map((s: { sessionId: string }) => s.sessionId), ["known-session", "unknown-session"]);
  assert.deepEqual(result.sessions.map((s: { date: string }) => s.date), ["2026-10-26", "2026-10-28"]);
  assert.equal(result.sessions[0].cwd, "/example/project-a");
  assert.equal(result.sessions[1].cwd, "/example/project-b");
  assert.equal(result.malformedLines, 2);
  assert.equal(result.duplicateEntries, 0);
  assert.equal(result.grandTotal.lead.usage.input + result.grandTotal.lead.usage.cachedInput
    + result.grandTotal.lead.usage.cacheWrite + result.grandTotal.lead.usage.output, 3435);
  assert.equal(result.grandTotal.sidekick.usage.input + result.grandTotal.sidekick.usage.cachedInput
    + result.grandTotal.sidekick.usage.cacheWrite + result.grandTotal.sidekick.usage.output, 4105);
  assert.equal(result.grandTotal.total.usd, null);
  assert.ok(Math.abs(result.grandTotal.total.knownUsd - 0.01116) < 1e-12);
  assert.deepEqual(fixtureHashes(), before, "fixture files are read-only");
});

test("CLI text table shows totals without user message bodies", () => {
  const { stdout, status } = runCli(["--dir", FIXTURES]);
  assert.equal(status, 0);
  assert.ok(stdout.includes("| Date | Cwd/project | Lead model | Sidekick model |"));
  assert.ok(stdout.includes("| 2026-10-26 | /example/project-a | example/lead | example/worker |"));
  assert.ok(stdout.includes("TOTAL (2 sessions)"));
  assert.ok(stdout.includes("3435"));
  assert.ok(stdout.includes("4105"));
  assert.ok(stdout.includes("Skipped 2 malformed line(s)"));
  assert.ok(!stdout.includes("must not appear in cost output"), "user message bodies must not leak into the table");
});

test("--since filters by UTC session date inclusively", () => {
  const { stdout } = runCli(["--dir", FIXTURES, "--since", "2026-10-28", "--json"]);
  const result = JSON.parse(stdout);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].sessionId, "unknown-session");
  assert.equal(result.grandTotal.total.knownUsd, 0);
  const boundary = JSON.parse(runCli(["--dir", FIXTURES, "--since", "2026-10-26", "--json"]).stdout);
  assert.equal(boundary.sessions.length, 2, "the boundary date itself is included");
});

test("invalid CLI arguments exit nonzero", () => {
  for (const since of ["2026-02-30", "2026-1-1", "not-a-date"]) {
    const result = runCli(["--dir", FIXTURES, "--since", since]);
    assert.notEqual(result.status, 0, `--since ${since}`);
    assert.ok(result.stderr.includes("--since"), result.stderr);
  }
  assert.notEqual(runCli(["--dir", FIXTURES, "--bogus"]).status, 0);
  assert.notEqual(runCli(["--dir", join(FIXTURES, "no-such-dir")]).status, 0);
  assert.equal(runCli(["--help"]).status, 0);
});

test("no-fusion and empty directories yield zero sessions", (t) => {
  mkdirSync(TEST_TMP_ROOT, { recursive: true });
  const dir = mkdtempSync(join(TEST_TMP_ROOT, "costs-empty-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(summarizeSessions(dir).sessions.length, 0);
  mkdirSync(join(dir, "nested"), { recursive: true });
  writeFileSync(join(dir, "nested", "plain.jsonl"), readFileSync(join(FIXTURES, "unrelated.jsonl")));
  const result = summarizeSessions(dir);
  assert.equal(result.sessions.length, 0, "sessions without fusion entries produce no row");
  assert.equal(result.grandTotal.total.knownUsd, 0);
  assert.equal(result.malformedLines, 0);
});

test("cloned sessions attribute shared history to the oldest scan", (t) => {
  mkdirSync(TEST_TMP_ROOT, { recursive: true });
  const dir = mkdtempSync(join(TEST_TMP_ROOT, "costs-clone-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const known = readFileSync(join(FIXTURES, "known.jsonl"), "utf8");
  const fusionLines = known.split("\n").filter((line) => line.includes('"customType":"fusion.'));
  const cloneHeader = JSON.stringify({
    type: "session", version: 3, id: "clone-session",
    timestamp: "2026-10-27T10:00:00.000Z", cwd: "/example/project-a-clone",
    parentSession: join(FIXTURES, "known.jsonl"),
  });
  writeFileSync(join(dir, "known.jsonl"), known);
  writeFileSync(join(dir, "clone.jsonl"), [cloneHeader, ...fusionLines, ""].join("\n"));

  const result = summarizeSessions(dir);
  assert.equal(result.sessions.length, 2);
  assert.equal(result.sessions[0].sessionId, "known-session");
  assert.ok(Math.abs((result.sessions[0].total.usd ?? NaN) - 0.01116) < 1e-12, "oldest session owns the shared history");
  assert.equal(result.sessions[1].sessionId, "clone-session");
  assert.equal(result.sessions[1].total.usd, 0, "the clone inherits no duplicate spend");
  assert.equal(result.sessions[1].lead.usage.input, 0);
  assert.deepEqual(result.sessions[1].lead.models, ["example/lead"], "clone keeps recorded lead model labels");
  assert.deepEqual(result.sessions[1].sidekick.models, ["example/worker"], "clone keeps recorded sidekick model labels");
  assert.equal(result.duplicateEntries, fusionLines.length);
  assert.ok(Math.abs(result.grandTotal.total.knownUsd - 0.01116) < 1e-12);

  const sinceClone = summarizeSessions(dir, "2026-10-27");
  assert.equal(sinceClone.sessions.length, 1);
  assert.equal(sinceClone.sessions[0].sessionId, "clone-session");
  assert.equal(sinceClone.grandTotal.total.knownUsd, 0,
    "the pre-since original still claims the shared entries");
});

test("defaultSessionsDir honors env override and agent dir fallback", (t) => {
  const previousSession = process.env.PI_CODING_AGENT_SESSION_DIR;
  const previousAgent = process.env.PI_CODING_AGENT_DIR;
  t.after(() => {
    if (previousSession === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousSession;
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgent;
  });
  process.env.PI_CODING_AGENT_SESSION_DIR = "/repo-local/sessions";
  process.env.PI_CODING_AGENT_DIR = "/repo-local/agent";
  assert.equal(defaultSessionsDir(), "/repo-local/sessions");
  delete process.env.PI_CODING_AGENT_SESSION_DIR;
  assert.equal(defaultSessionsDir(), "/repo-local/agent/sessions");
});
