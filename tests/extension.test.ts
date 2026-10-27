import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { AgentSessionEventListener } from "@earendil-works/pi-coding-agent";
import { createFusionExtension } from "../src/index.ts";
import { PersistentSidekick } from "../src/sidekick.ts";
import type { SidekickProgress, SidekickReport, SidekickSession } from "../src/sidekick.ts";
import { LEAD_GUIDANCE, SIDEKICK_DESCRIPTION } from "../src/prompts.ts";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const TEST_TMP_ROOT = join(REPO_ROOT, ".cache", "test-tmp");

function makeUsage(input: number, cacheRead = 0, cacheWrite = 0, output = 0) {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + cacheRead + cacheWrite + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function assistantMessage(usage: ReturnType<typeof makeUsage>, stopReason = "stop") {
  return {
    role: "assistant",
    provider: "magpie",
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
    model: "magpie/devin/swe-2",
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

test("extension registers the sidekick tool, appends guidance once, and disposes on shutdown", async () => {
  const tools = new Map<string, Record<string, unknown>>();
  const flags = new Map<string, unknown>();
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const entries: Array<{ customType: string; data: unknown }> = [];
  const pi = {
    registerFlag: (name: string, options: unknown) => flags.set(name, options),
    getFlag: (name: string) => (name === "fusion-sidekick-model" ? "test/fake" : undefined),
    registerTool: (tool: Record<string, unknown>) => tools.set(tool.name as string, tool),
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

  const ctx = { cwd: REPO_ROOT, modelRegistry: {} };
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
  assert.equal((leadEntry.data as { model: string }).model, "magpie/devin/swe-2");
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
