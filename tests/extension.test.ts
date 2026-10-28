import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { AgentSessionEventListener } from "@earendil-works/pi-coding-agent";
import { createFusionExtension } from "../src/index.ts";
import { PersistentSidekick } from "../src/sidekick.ts";
import type { SidekickProgress, SidekickReport, SidekickSession } from "../src/sidekick.ts";
import { LEAD_GUIDANCE, SIDEKICK_DESCRIPTION } from "../src/prompts.ts";
import { aggregateCosts } from "../src/costs.ts";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const TEST_TMP_ROOT = join(REPO_ROOT, ".cache", "test-tmp");

function makeUsage(
  input: number,
  cacheRead = 0,
  cacheWrite = 0,
  output = 0,
  cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
) {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + cacheRead + cacheWrite + output,
    cost,
  };
}

function assistantMessage(usage: ReturnType<typeof makeUsage>, stopReason = "stop") {
  return {
    role: "assistant",
    provider: "test",
    model: "devin/swe-2",
    api: "test-api",
    content: [{ type: "text", text: "…" }],
    usage,
    stopReason,
    timestamp: 0,
  };
}

const VALID_REPORT = JSON.stringify({
  summary: "implemented the brief",
  changedFiles: ["src/a.ts"],
  tests: ["node --test: pass"],
  remainingIssues: [],
});

class FakeSession implements SidekickSession {
  sessionId = "fake-session-1";
  listeners = new Set<AgentSessionEventListener>();
  prompts: string[] = [];
  abortCount = 0;
  disposeCount = 0;
  lastAssistantText = VALID_REPORT;
  /** Steps run inside prompt() before it resolves. */
  script: Array<() => void> = [];
  /** When set, prompt() resolves only after abort() is called. */
  promptWaitsForAbort = false;
  private promptResolver: (() => void) | undefined;
  private abortRequested = false;

  subscribe(listener: AgentSessionEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
    for (const step of this.script) step();
    if (this.promptWaitsForAbort && !this.abortRequested) {
      await new Promise<void>((resolve) => {
        this.promptResolver = resolve;
      });
    }
  }

  getLastAssistantText(): string | undefined {
    return this.lastAssistantText;
  }

  async abort(): Promise<void> {
    this.abortCount++;
    this.abortRequested = true;
    this.promptResolver?.();
  }

  dispose(): void {
    this.disposeCount++;
  }

  // Fake events are hand-built and don't need the full AgentSessionEvent shape.
  emit(event: any): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}

function makeSidekick(
  session: FakeSession,
  options: { cwd?: string; onProgress?: (p: SidekickProgress) => void; factory?: () => Promise<SidekickSession> } = {},
) {
  const factoryCalls: number[] = [];
  const sidekick = new PersistentSidekick({
    cwd: options.cwd ?? REPO_ROOT,
    model: "test/devin/swe-2",
    createSession: () => {
      factoryCalls.push(Date.now());
      return options.factory ? options.factory() : Promise.resolve(session);
    },
    onProgress: options.onProgress,
  });
  return { sidekick, factoryCalls };
}

test("reuses one session across two sequential briefs and reports per-call plus cumulative usage", async () => {
  const session = new FakeSession();
  const progressLog: SidekickProgress[] = [];
  const { sidekick, factoryCalls } = makeSidekick(session, {
    onProgress: (p) => progressLog.push(p),
  });
  session.script = [
    () => session.emit({ type: "turn_start" }),
    () => session.emit({ type: "tool_execution_start", toolCallId: "1", toolName: "write", args: {} }),
    () => session.emit({ type: "tool_execution_start", toolCallId: "2", toolName: "read", args: {} }),
    () => session.emit({ type: "message_end", message: assistantMessage(makeUsage(100, 40, 10, 20)) }),
  ];
  const first = await sidekick.run("brief one");
  session.script = [
    () => session.emit({ type: "turn_start" }),
    () => session.emit({ type: "message_end", message: assistantMessage(makeUsage(50, 30, 0, 10)) }),
  ];
  const second = await sidekick.run("brief two");

  session.script = [
    () =>
      session.emit({
        type: "message_update",
        message: assistantMessage(makeUsage(60, 30, 0, 12)),
        assistantMessageEvent: {},
      }),
  ];
  const progressBeforeUpdateOnly = progressLog.length;
  await sidekick.run("brief three");
  assert.equal(
    progressLog.length,
    progressBeforeUpdateOnly + 1,
    "message_update alone must not emit progress; only the finish emit counts",
  );

  assert.equal(factoryCalls.length, 1);
  assert.equal(first.report.sessionId, "fake-session-1");
  assert.equal(second.report.sessionId, "fake-session-1");
  assert.deepEqual(session.prompts, ["brief one", "brief two", "brief three"]);

  assert.equal(first.report.call, 1);
  assert.equal(first.report.turns, 1);
  assert.equal(first.report.toolCalls, 2);
  assert.equal(first.report.writeToolCalls, 1);
  assert.deepEqual(first.report.usage, { input: 100, cachedInput: 40, cacheWrite: 10, output: 20 });
  assert.deepEqual(first.report.cumulativeUsage, first.report.usage);
  assert.equal(first.usage.input, 100);
  assert.equal(first.usage.totalTokens, 170);

  assert.equal(second.report.call, 2);
  assert.equal(second.report.turns, 1);
  assert.equal(second.report.toolCalls, 0);
  assert.deepEqual(second.report.usage, { input: 50, cachedInput: 30, cacheWrite: 0, output: 10 });
  assert.deepEqual(second.report.cumulativeUsage, { input: 150, cachedInput: 70, cacheWrite: 10, output: 30 });
  assert.equal(second.report.reportFormat, "json");
  assert.equal(first.report.failed, false);
  assert.ok(progressLog.length > 0);
});

test("serializes concurrent briefs on the shared session", async () => {
  const session = new FakeSession();
  let inPrompt = 0;
  let maxInPrompt = 0;
  const gates: Array<() => void> = [];
  session.prompt = (text: string) => {
    inPrompt++;
    maxInPrompt = Math.max(maxInPrompt, inPrompt);
    session.prompts.push(text);
    return new Promise<void>((resolve) => {
      gates.push(() => {
        inPrompt--;
        resolve();
      });
    });
  };
  const { sidekick } = makeSidekick(session);
  const runA = sidekick.run("first brief");
  const runB = sidekick.run("second brief");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(session.prompts.length, 1, "second brief must wait for the first");
  gates[0]();
  await runA;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(session.prompts, ["first brief", "second brief"]);
  gates[1]();
  const resultB = await runB;
  assert.equal(resultB.report.call, 2);
  assert.equal(maxInPrompt, 1);
});

test("rejects blank briefs without creating a session", async () => {
  const session = new FakeSession();
  const { sidekick, factoryCalls } = makeSidekick(session);
  await assert.rejects(() => sidekick.run("   "), /non-empty/);
  assert.equal(factoryCalls.length, 0);
});

test("an already-aborted signal never creates the worker session", async () => {
  const session = new FakeSession();
  const { sidekick, factoryCalls } = makeSidekick(session);
  const controller = new AbortController();
  controller.abort();
  const { report } = await sidekick.run("brief", controller.signal);
  assert.equal(factoryCalls.length, 0);
  assert.equal(session.prompts.length, 0);
  assert.equal(report.failed, true);
  assert.ok(report.remainingIssues.some((issue) => /abort/i.test(issue)));
});

test("active cancellation aborts the session, marks the report failed, and cleans up", async () => {
  const session = new FakeSession();
  session.promptWaitsForAbort = true;
  session.script = [
    () => session.emit({ type: "message_end", message: assistantMessage(makeUsage(10, 0, 0, 5)) }),
  ];
  const { sidekick } = makeSidekick(session);
  const controller = new AbortController();
  const pending = sidekick.run("brief", controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(session.listeners.size, 1);
  controller.abort();
  const { report } = await pending;
  assert.equal(session.abortCount, 1);
  assert.equal(session.listeners.size, 0);
  assert.equal(report.failed, true);
  assert.deepEqual(report.usage, { input: 10, cachedInput: 0, cacheWrite: 0, output: 5 });
  assert.ok(report.remainingIssues.some((issue) => /abort/i.test(issue)));
});

test("malformed final text falls back without invented tests", async () => {
  const session = new FakeSession();
  session.lastAssistantText = "I changed things but did not emit JSON.";
  const { sidekick } = makeSidekick(session);
  const { report } = await sidekick.run("brief");
  assert.equal(report.reportFormat, "text");
  assert.deepEqual(report.tests, []);
  assert.equal(report.summary, "I changed things but did not emit JSON.");
  assert.ok(
    report.remainingIssues.includes("Sidekick did not return a valid JSON report; test outcomes are unverified."),
  );
  assert.equal(report.failed, false);
});

test("accepts a report wrapped in a single ```json fence", async () => {
  const session = new FakeSession();
  session.lastAssistantText = `\`\`\`json\n${VALID_REPORT}\n\`\`\``;
  const { sidekick } = makeSidekick(session);
  const { report } = await sidekick.run("brief");
  assert.equal(report.reportFormat, "json");
  assert.equal(report.summary, "implemented the brief");
  assert.deepEqual(report.tests, ["node --test: pass"]);
});

test("dispose aborts and disposes the session exactly once, including while creation is in flight", async () => {
  const session = new FakeSession();
  session.promptWaitsForAbort = true;
  let releaseFactory: (() => void) | undefined;
  const { sidekick, factoryCalls } = makeSidekick(session, {
    factory: () =>
      new Promise<SidekickSession>((resolve) => {
        releaseFactory = () => resolve(session);
      }),
  });
  const pending = sidekick.run("brief");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(factoryCalls.length, 1, "session creation should be in flight");
  const disposeA = sidekick.dispose();
  const disposeB = sidekick.dispose();
  releaseFactory?.();
  await Promise.all([disposeA, disposeB, pending]);
  assert.equal(factoryCalls.length, 1);
  assert.equal(session.prompts.length, 0, "disposal during in-flight creation must not reach a paid prompt");
  assert.equal(session.abortCount, 1);
  assert.equal(session.disposeCount, 1);
  const { report } = await sidekick.run("brief after dispose");
  assert.equal(report.failed, true);
  assert.equal(factoryCalls.length, 1);
});

test("cancellation during lazy session creation never sends a prompt", async () => {
  const session = new FakeSession();
  let releaseFactory: (() => void) | undefined;
  const { sidekick } = makeSidekick(session, {
    factory: () =>
      new Promise<SidekickSession>((resolve) => {
        releaseFactory = () => resolve(session);
      }),
  });
  const controller = new AbortController();
  const pending = sidekick.run("brief", controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  releaseFactory?.();
  const { report } = await pending;
  assert.equal(report.failed, true);
  assert.equal(session.prompts.length, 0);
  assert.ok(report.remainingIssues.some((issue) => /abort/i.test(issue)));
});

test("git stat reports tracked changes and untracked paths in a real repository", async (t) => {
  mkdirSync(TEST_TMP_ROOT, { recursive: true });
  const dir = mkdtempSync(join(TEST_TMP_ROOT, "git-fixture-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (args: string[]) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
      cwd: dir,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  git(["init"]);
  writeFileSync(join(dir, "tracked.ts"), "export const v = 1;\n");
  git(["add", "tracked.ts"]);
  git(["-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-m", "init"]);
  writeFileSync(join(dir, "tracked.ts"), "export const v = 2;\n");
  mkdirSync(join(dir, "newdir"));
  writeFileSync(join(dir, "newdir", "fresh.ts"), "export const n = 1;\n");

  const session = new FakeSession();
  const { sidekick } = makeSidekick(session, { cwd: dir });
  const { report } = await sidekick.run("brief");
  assert.ok(report.changedFiles.includes("tracked.ts"));
  assert.ok(report.changedFiles.includes("newdir/fresh.ts"));
  assert.match(report.diffStat, /tracked\.ts/);
  assert.match(report.diffStat, /untracked:.*newdir\/fresh\.ts/);
  assert.equal(report.failed, false);
});

test("non-git directory reports an explicit unavailable stat", async (t) => {
  mkdirSync(TEST_TMP_ROOT, { recursive: true });
  const dir = mkdtempSync(join(TEST_TMP_ROOT, "nogit-fixture-"));
  // The fixture lives inside this repo's work tree; ceiling discovery at its parent so git sees it as a non-repo.
  const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = TEST_TMP_ROOT;
  t.after(() => {
    if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
    rmSync(dir, { recursive: true, force: true });
  });
  const session = new FakeSession();
  const { sidekick } = makeSidekick(session, { cwd: dir });
  const { report } = await sidekick.run("brief");
  assert.match(report.diffStat, /not a git repository/);
  assert.equal(report.failed, false);
});

function makeCtx(entries: unknown[] = [], overrides: Record<string, unknown> = {}) {
  const statuses: Array<[string, string | undefined]> = [];
  const notifications: Array<{ message: string; type?: string }> = [];
  const ctx = {
    cwd: REPO_ROOT,
    hasUI: true,
    model: undefined,
    ui: {
      notify: (message: string, type?: string) => notifications.push({ message, type }),
      setStatus: (key: string, text: string | undefined) => statuses.push([key, text]),
    },
    sessionManager: { getEntries: () => entries },
    modelRegistry: {
      find: () => undefined,
      getRegisteredProviderConfig: () => undefined,
      getRegisteredNativeProvider: () => undefined,
    },
    ...overrides,
  };
  return { ctx, statuses, notifications };
}

test("extension registers the sidekick tool, appends guidance once, and disposes on shutdown", async () => {
  const tools = new Map<string, Record<string, unknown>>();
  const flags = new Map<string, unknown>();
  const commands = new Map<string, Record<string, unknown>>();
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const entries: Array<{ customType: string; data: unknown }> = [];
  const pi = {
    registerFlag: (name: string, options: unknown) => flags.set(name, options),
    getFlag: (name: string) => (name === "fusion-sidekick-model" ? "test/fake" : undefined),
    registerTool: (tool: Record<string, unknown>) => tools.set(tool.name as string, tool),
    registerCommand: (name: string, options: Record<string, unknown>) => commands.set(name, options),
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
    appendEntry: (customType: string, data?: unknown) => entries.push({ customType, data }),
  };
  const session = new FakeSession();
  let factoryCalls = 0;
  createFusionExtension(pi as never, {
    createSession: async () => {
      factoryCalls++;
      return session;
    },
  });

  assert.ok(flags.has("fusion-sidekick-model"));
  const tool = tools.get("sidekick");
  assert.ok(tool, "sidekick tool registered");
  assert.equal(tool.label, "Sidekick");
  assert.equal(tool.description, SIDEKICK_DESCRIPTION);
  assert.equal(tool.executionMode, "sequential");

  const { ctx } = makeCtx();
  const execute = tool.execute as (
    id: string,
    params: { brief: string },
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: unknown,
  ) => Promise<{ isError?: boolean; details?: SidekickReport; usage?: unknown; structuredContent?: unknown }>;
  const resultA = await execute("call-1", { brief: "brief A" }, undefined, undefined, ctx);
  const resultB = await execute("call-2", { brief: "brief B" }, undefined, undefined, ctx);
  assert.equal(factoryCalls, 1);
  assert.equal(resultA.isError, false);
  assert.equal(resultB.details?.sessionId, "fake-session-1");
  assert.ok(entries.some((entry) => entry.customType === "fusion.sidekick_usage"));

  const beforeStart = handlers.get("before_agent_start")?.[0];
  assert.ok(beforeStart);
  const firstPrompt = "BASE PROMPT";
  const updated = (await beforeStart({ type: "before_agent_start", systemPrompt: firstPrompt }, ctx)) as
    | { systemPrompt: string }
    | undefined;
  assert.ok(updated?.systemPrompt.includes(LEAD_GUIDANCE));
  const second = (await beforeStart(
    { type: "before_agent_start", systemPrompt: updated!.systemPrompt },
    ctx,
  )) as { systemPrompt: string } | undefined;
  assert.equal(second, undefined, "guidance must not be appended twice");

  const messageEnd = handlers.get("message_end")?.[0];
  assert.ok(messageEnd);
  await messageEnd({ type: "message_end", message: assistantMessage(makeUsage(5, 1, 0, 2)) }, ctx);
  const leadEntry = entries.find((entry) => entry.customType === "fusion.lead_usage");
  assert.ok(leadEntry);
  assert.equal((leadEntry.data as { model: string }).model, "test/devin/swe-2");
  assert.deepEqual((leadEntry.data as { usage: unknown }).usage, {
    input: 5,
    cachedInput: 1,
    cacheWrite: 0,
    output: 2,
  });

  const shutdown = handlers.get("session_shutdown")?.[0];
  assert.ok(shutdown);
  await shutdown({ type: "session_shutdown", reason: "quit" }, ctx);
  assert.equal(session.disposeCount, 1);
});

test("sidekick requires configuration, accepts the environment, and prefers the flag", async (t) => {
  const previous = process.env.FUSION_SIDEKICK_MODEL;
  delete process.env.FUSION_SIDEKICK_MODEL;
  t.after(() => {
    if (previous === undefined) delete process.env.FUSION_SIDEKICK_MODEL;
    else process.env.FUSION_SIDEKICK_MODEL = previous;
  });
  let flag: unknown;
  const chosen: string[] = [];
  const createTool = () => {
    let tool: Record<string, unknown> | undefined;
    createFusionExtension({
      registerFlag() {},
      getFlag: () => flag,
      registerTool: (value: Record<string, unknown>) => { tool = value; },
      registerCommand() {},
      on() {},
      appendEntry() {},
    } as never, {
      createSession: async (_ctx, model) => {
        chosen.push(model);
        return new FakeSession();
      },
    });
    assert.ok(tool);
    return tool.execute as (
      id: string, params: { brief: string }, signal: undefined, onUpdate: undefined, ctx: unknown,
    ) => Promise<unknown>;
  };
  const { ctx } = makeCtx();
  const fromEnv = createTool();
  await assert.rejects(fromEnv("missing", { brief: "brief" }, undefined, undefined, ctx),
    /Set --fusion-sidekick-model.*FUSION_SIDEKICK_MODEL/);
  assert.deepEqual(chosen, [], "missing configuration must not create a model session");
  process.env.FUSION_SIDEKICK_MODEL = "test/environment";
  await fromEnv("env", { brief: "brief" }, undefined, undefined, ctx);
  flag = "test/flag";
  await fromEnv("reused", { brief: "brief" }, undefined, undefined, ctx);
  await createTool()("flag", { brief: "brief" }, undefined, undefined, ctx);
  assert.deepEqual(chosen, ["test/environment", "test/flag"], "one model per runtime; flag wins for a new runtime");
});

const KNOWN_COSTS_TEXT = [
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

function knownFixtureEntries(): Array<Record<string, unknown>> {
  const file = join(REPO_ROOT, "tests", "fixtures", "costs", "known.jsonl");
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.includes('"customType":"fusion.'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function makePi(persisted: Array<Record<string, unknown>>) {
  const commands = new Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }>();
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const tools = new Map<string, Record<string, unknown>>();
  let appended = 0;
  const pi = {
    registerFlag() {},
    getFlag: (name: string) => (name === "fusion-sidekick-model" ? "test/fake" : undefined),
    registerTool: (tool: Record<string, unknown>) => tools.set(tool.name as string, tool),
    registerCommand: (name: string, options: never) => commands.set(name, options),
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
    appendEntry: (customType: string, data?: unknown) => {
      appended += 1;
      persisted.push({
        type: "custom", customType,
        id: `appended-${appended}`, timestamp: `2026-10-26T11:00:${String(appended).padStart(2, "0")}.000Z`,
        data,
      });
    },
  };
  return { pi, commands, handlers, tools };
}

test("/fusion-cost reports persisted session usage, updates status, and restores after reload", async () => {
  const persisted = knownFixtureEntries();
  const session = new FakeSession();
  let factoryCalls = 0;
  const { pi, commands, handlers } = makePi(persisted);
  createFusionExtension(pi as never, {
    createSession: async () => {
      factoryCalls++;
      return session;
    },
  });
  const model = { provider: "test", id: "devin/swe-2", cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } };
  const { ctx, statuses, notifications } = makeCtx(persisted, {
    model,
    modelRegistry: {
      find: (provider: string, id: string) =>
        provider === model.provider && id === model.id ? model : undefined,
      getRegisteredProviderConfig: () => undefined,
      getRegisteredNativeProvider: () => undefined,
    },
  });

  const sessionStart = handlers.get("session_start")?.[0];
  assert.ok(sessionStart);
  await sessionStart({ type: "session_start", reason: "startup" }, ctx);
  assert.ok(persisted.some((entry) => entry.customType === "fusion.models"));

  const command = commands.get("fusion-cost");
  assert.ok(command, "fusion-cost command registered");
  await command.handler("", ctx);
  assert.equal(notifications.at(-1)?.message, KNOWN_COSTS_TEXT);
  assert.equal(factoryCalls, 0, "the command must not create a sidekick/model session");
  assert.equal(statuses.at(-1)?.[1], "fusion: lead $0.006400 · sidekick $0.004760");

  const messageEnd = handlers.get("message_end")?.[0];
  assert.ok(messageEnd);
  const cost = { input: 0.005, output: 0.005, cacheRead: 0, cacheWrite: 0, total: 0.01 };
  await messageEnd({ type: "message_end", message: assistantMessage(makeUsage(100, 0, 0, 20, cost)) }, ctx);
  const leadEntry = persisted.filter((entry) => entry.customType === "fusion.lead_usage").at(-1);
  assert.equal(leadEntry?.customType, "fusion.lead_usage");
  assert.deepEqual((leadEntry?.data as { cost: unknown }).cost, cost);
  assert.equal((leadEntry?.data as { ratesConfigured: boolean }).ratesConfigured, true);
  assert.equal(statuses.at(-1)?.[1], "fusion: lead $0.016400 · sidekick $0.004760");

  await command.handler("", ctx);
  const updatedText = notifications.at(-1)?.message;
  assert.ok(updatedText?.includes("Total USD: $0.021160"), updatedText);

  // A reloaded extension over the same persisted entries reports the same totals.
  const { pi: pi2, commands: commands2 } = makePi(persisted);
  createFusionExtension(pi2 as never, { createSession: async () => session });
  const { ctx: ctx2, notifications: notifications2 } = makeCtx(persisted, { model });
  await commands2.get("fusion-cost")!.handler("", ctx2);
  assert.equal(notifications2.at(-1)?.message, updatedText, "persisted counts survive a reload");

  // A fresh empty session must not leak prior totals.
  const { ctx: ctx3, notifications: notifications3 } = makeCtx([]);
  await commands2.get("fusion-cost")!.handler("", ctx3);
  assert.ok(notifications3.at(-1)?.message.includes("Total USD: $0.000000"));
  assert.equal(aggregateCosts(ctx3.sessionManager.getEntries()).total.usd, 0);

  const shutdown = handlers.get("session_shutdown")?.[0];
  assert.ok(shutdown);
  await shutdown({ type: "session_shutdown", reason: "quit" }, ctx);
  assert.equal(statuses.at(-1)?.[1], undefined, "shutdown clears the footer status");
});

test("sidekick progress reports per-call raw cost, distinct callIds, and survives abort", async () => {
  const session = new FakeSession();
  const progressLog: SidekickProgress[] = [];
  const { sidekick } = makeSidekick(session, { onProgress: (p) => progressLog.push(p) });
  const costA = { input: 0.5, output: 0.25, cacheRead: 0.125, cacheWrite: 0.0625, total: 0.9375 };
  const costB = { input: 0.25, output: 0.125, cacheRead: 0.0625, cacheWrite: 0.03125, total: 0.46875 };
  const costSum = { input: 0.75, output: 0.375, cacheRead: 0.1875, cacheWrite: 0.09375, total: 1.40625 };
  const emitBoth = () => {
    session.emit({ type: "message_end", message: assistantMessage(makeUsage(10, 0, 0, 5, costA)) });
    session.emit({ type: "message_end", message: assistantMessage(makeUsage(10, 0, 0, 5, costB)) });
  };

  session.script = [emitBoth];
  const first = await sidekick.run("brief one");
  assert.deepEqual(first.report.cost, costSum, "final report cost is the category-wise sum");
  assert.deepEqual(first.usage.cost, costSum, "returned tool usage carries the same cost");
  assert.equal(first.report.complete, true);
  assert.equal(first.report.ratesConfigured, true, "positive recorded cost proves configured rates");

  session.script = [emitBoth];
  const second = await sidekick.run("brief two");
  assert.notEqual(first.report.callId, second.report.callId, "each call gets a fresh UUID");

  const snapshotCost = progressLog.filter((p) => p.callId === first.report.callId).map((p) => p.cost.total);
  assert.deepEqual(snapshotCost, [costA.total, costSum.total, costSum.total],
    "emitted snapshots are cumulative within the call and end complete");
  const finalSnapshots = progressLog.filter((p) => p.complete);
  assert.equal(finalSnapshots.length, 2);
  assert.notStrictEqual(finalSnapshots[0].cost, first.report.cost, "report cost is an independent copy");

  const entries = progressLog.map((p, i) => ({
    type: "custom", customType: "fusion.sidekick_usage",
    id: `snap-${i}`, timestamp: `2026-10-26T12:00:${String(i).padStart(2, "0")}.000Z`, data: p,
  }));
  const aggregated = aggregateCosts(entries);
  assert.equal(aggregated.sidekick.calls, 2, "snapshots aggregate once per call");
  assert.deepEqual(aggregated.sidekick.cost.usd, 2 * costSum.total);
  assert.equal(aggregated.incompleteCalls, 0);

  // An aborted call keeps the cost it already consumed.
  const aborting = new FakeSession();
  aborting.promptWaitsForAbort = true;
  aborting.script = [
    () => aborting.emit({ type: "message_end", message: assistantMessage(makeUsage(10, 0, 0, 5, costA)) }),
  ];
  const { sidekick: abortedSidekick } = makeSidekick(aborting);
  const controller = new AbortController();
  const pending = abortedSidekick.run("brief", controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  const { report } = await pending;
  assert.equal(report.failed, true);
  assert.equal(report.complete, true, "the failure path still emits a final snapshot");
  assert.deepEqual(report.cost, costA, "consumed cost is kept on abort");
});

test("sidekick marks rates unconfigured when model and recorded cost show no rates", async (t) => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(TEST_TMP_ROOT, "no-models-config");
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });
  const session = new FakeSession();
  (session as unknown as Record<string, unknown>).model = {
    provider: "test", id: "devin/swe-2",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const { sidekick } = makeSidekick(session);
  session.script = [
    () => session.emit({ type: "message_end", message: assistantMessage(makeUsage(10, 0, 0, 5)) }),
  ];
  const { report } = await sidekick.run("brief");
  assert.equal(report.ratesConfigured, false,
    "all-zero recorded cost with an all-zero undeclared catalog is unknown, not free");
});

test("shutdown clears status after the last in-flight sidekick snapshot", async () => {
  const persisted: Array<Record<string, unknown>> = [];
  const { pi, tools, handlers } = makePi(persisted);
  const session = new FakeSession();
  session.promptWaitsForAbort = true;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  session.script = [() => {
    session.emit({ type: "turn_start" });
    session.emit({ type: "message_end", message: assistantMessage(makeUsage(10, 0, 0, 5,
      { input: 0.1, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.1 })) });
    markStarted();
  }];
  createFusionExtension(pi as never, { createSession: async () => session });
  const { ctx, statuses } = makeCtx(persisted);
  const execute = tools.get("sidekick")!.execute as
    (id: string, params: { brief: string }, signal: undefined, update: undefined, ctx: unknown) => Promise<unknown>;
  const running = execute("live-call", { brief: "fixture only" }, undefined, undefined, ctx);
  await started;
  await handlers.get("session_shutdown")![0]({ type: "session_shutdown", reason: "quit" }, ctx);
  await running;
  assert.ok(persisted.some((entry) => entry.customType === "fusion.sidekick_usage"
    && (entry.data as SidekickProgress).complete));
  assert.equal(aggregateCosts(persisted).sidekick.cost.usd, 0.1);
  assert.equal(statuses.at(-1)?.[1], undefined);
});
