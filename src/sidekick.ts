import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import type { Usage } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  readStoredCredential,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentSession, AgentSessionEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SIDEKICK_GUIDANCE } from "./prompts.ts";
import { captureCost } from "./costs.ts";
import { addUsage, emptyUsage, usageFromPi } from "./usage.ts";
import type { TokenUsage } from "./usage.ts";

export type SidekickSession = Pick<
  AgentSession,
  "sessionId" | "subscribe" | "prompt" | "getLastAssistantText" | "abort" | "dispose"
> &
  Partial<Pick<AgentSession, "model" | "modelRuntime">>;

export interface SidekickProgress {
  sessionId: string;
  call: number;
  callId: string;
  model: string;
  usage: TokenUsage;
  cost: Usage["cost"];
  ratesConfigured: boolean;
  complete: boolean;
  turns: number;
  toolCalls: number;
  writeToolCalls: number;
}

export interface SidekickReport extends SidekickProgress {
  summary: string;
  changedFiles: string[];
  tests: string[];
  remainingIssues: string[];
  diffStat: string;
  reportFormat: "json" | "text";
  cumulativeUsage: TokenUsage;
  failed: boolean;
}

/** Failure raised by the extension itself; its message is safe to surface to the lead. */
export class SidekickError extends Error {}

const MAX_TEXT_CHARS = 20000;
const MAX_DIFF_STAT_CHARS = 8000;
const MAX_LIST_ITEMS = 200;
const MAX_LIST_ITEM_CHARS = 500;

function bounded(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}\n… (truncated)` : value;
}

function boundedList(items: string[]): string[] {
  return items.slice(0, MAX_LIST_ITEMS).map((item) => bounded(item, MAX_LIST_ITEM_CHARS));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

const INVALID_REPORT_ISSUE = "Sidekick did not return a valid JSON report; test outcomes are unverified.";

interface ParsedReport {
  summary: string;
  changedFiles: string[];
  tests: string[];
  remainingIssues: string[];
  reportFormat: "json" | "text";
}

function parseReportText(raw: string): ParsedReport {
  const trimmed = raw.trim();
  const fenced = /^```json\s*\r?\n([\s\S]*?)\r?\n?```\s*$/.exec(trimmed);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    parsed = undefined;
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.summary === "string" &&
      isStringArray(record.changedFiles) &&
      isStringArray(record.tests) &&
      isStringArray(record.remainingIssues)
    ) {
      return {
        summary: bounded(record.summary, MAX_TEXT_CHARS),
        changedFiles: boundedList(record.changedFiles),
        tests: boundedList(record.tests),
        remainingIssues: boundedList(record.remainingIssues),
        reportFormat: "json",
      };
    }
  }
  return {
    summary: bounded(trimmed, MAX_TEXT_CHARS),
    changedFiles: [],
    tests: [],
    remainingIssues: [INVALID_REPORT_ISSUE],
    reportFormat: "text",
  };
}

interface GitSnapshot {
  available: boolean;
  changedFiles: string[];
  diffStat: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 1024 * 1024,
  });
}

function gitSnapshot(cwd: string): GitSnapshot {
  try {
    git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    return { available: false, changedFiles: [], diffStat: "git diff stat unavailable (not a git repository)" };
  }
  let hasHead = true;
  try {
    git(cwd, ["rev-parse", "--verify", "HEAD"]);
  } catch {
    hasHead = false;
  }
  const changed = new Set<string>();
  const untracked: string[] = [];
  const entries = git(cwd, ["status", "--porcelain=v1", "-z", "-uall"]).split("\0");
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4) continue;
    const path = entry.slice(3);
    if (entry[0] === "R" || entry[0] === "C" || entry[1] === "R" || entry[1] === "C") {
      const from = entries[++i];
      if (from) changed.add(from);
    }
    changed.add(path);
    if (entry.startsWith("??")) untracked.push(path);
  }
  let diffStat = "";
  if (hasHead) {
    try {
      diffStat = git(cwd, ["diff", "--no-ext-diff", "--stat", "HEAD", "--"]).trim();
    } catch {
      diffStat = "";
    }
  }
  if (untracked.length > 0) {
    diffStat += `${diffStat ? "\n" : ""}untracked: ${untracked.join(", ")}`;
  }
  if (!diffStat) {
    diffStat = hasHead ? "git diff stat: no changes" : "git diff stat unavailable (no HEAD commit)";
  }
  return { available: true, changedFiles: [...changed].sort(), diffStat: bounded(diffStat, MAX_DIFF_STAT_CHARS) };
}

function emptyRawUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function addRawUsage(target: Usage, source: Usage): void {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  if (typeof source.cacheWrite1h === "number") {
    target.cacheWrite1h = (target.cacheWrite1h ?? 0) + source.cacheWrite1h;
  }
  // reasoning is a subset of output, never add it again to totalTokens.
  target.totalTokens += source.totalTokens;
  target.cost.input += source.cost.input;
  target.cost.output += source.cost.output;
  target.cost.cacheRead += source.cost.cacheRead;
  target.cost.cacheWrite += source.cost.cacheWrite;
  target.cost.total += source.cost.total;
}

export interface PersistentSidekickOptions {
  cwd: string;
  model: string;
  createSession: () => Promise<SidekickSession>;
  onProgress?: (progress: SidekickProgress) => void;
}

export class PersistentSidekick {
  private readonly cwd: string;
  private readonly model: string;
  private readonly createSession: () => Promise<SidekickSession>;
  private readonly onProgress?: (progress: SidekickProgress) => void;
  private sessionPromise: Promise<SidekickSession> | undefined;
  private tail: Promise<void> = Promise.resolve();
  private callCounter = 0;
  private cumulativeUsage: TokenUsage = emptyUsage();
  private disposed = false;
  private disposePromise: Promise<void> | undefined;

  constructor(options: PersistentSidekickOptions) {
    this.cwd = options.cwd;
    this.model = options.model;
    this.createSession = options.createSession;
    this.onProgress = options.onProgress;
  }

  private getSession(): Promise<SidekickSession> {
    if (this.disposed) throw new SidekickError("Sidekick has been disposed");
    if (!this.sessionPromise) {
      const pending = this.createSession();
      this.sessionPromise = pending;
      pending.catch(() => {
        if (this.sessionPromise === pending) this.sessionPromise = undefined;
      });
    }
    return this.sessionPromise;
  }

  run(brief: string, signal?: AbortSignal): Promise<{ report: SidekickReport; usage: Usage }> {
    if (typeof brief !== "string" || brief.trim().length === 0) {
      return Promise.reject(new SidekickError("sidekick brief must be a non-empty string"));
    }
    const job = this.tail.then(() => this.runOnce(brief, signal));
    this.tail = job.then(
      () => undefined,
      () => undefined,
    );
    return job;
  }

  private async runOnce(brief: string, signal?: AbortSignal): Promise<{ report: SidekickReport; usage: Usage }> {
    const call = ++this.callCounter;
    const callUsage = emptyRawUsage();
    const progress: SidekickProgress = {
      sessionId: "",
      call,
      callId: randomUUID(),
      model: this.model,
      usage: emptyUsage(),
      cost: callUsage.cost,
      ratesConfigured: true,
      complete: false,
      turns: 0,
      toolCalls: 0,
      writeToolCalls: 0,
    };
    let failed = false;
    let modelEndedBadly = false;
    let aborted = signal?.aborted ?? false;
    const emit = () => this.onProgress?.({ ...progress, usage: { ...progress.usage }, cost: { ...progress.cost } });
    const finish = (parsed: ParsedReport, extraIssues: string[]): { report: SidekickReport; usage: Usage } => {
      progress.complete = true;
      let gitState: GitSnapshot;
      try {
        gitState = gitSnapshot(this.cwd);
      } catch {
        gitState = {
          available: false,
          changedFiles: [],
          diffStat: "git diff stat unavailable (git inspection failed)",
        };
      }
      const report: SidekickReport = {
        ...progress,
        usage: { ...progress.usage },
        cost: { ...progress.cost },
        summary: parsed.summary,
        changedFiles: gitState.available ? gitState.changedFiles : parsed.changedFiles,
        tests: parsed.tests,
        remainingIssues: [...parsed.remainingIssues, ...extraIssues],
        diffStat: gitState.diffStat,
        reportFormat: parsed.reportFormat,
        cumulativeUsage: { ...this.cumulativeUsage },
        failed,
      };
      emit();
      return { report, usage: callUsage };
    };

    if (aborted || this.disposed) {
      failed = true;
      return finish(
        { summary: "", changedFiles: [], tests: [], remainingIssues: [], reportFormat: "text" },
        [aborted ? "Sidekick call was aborted before it started." : "Sidekick has been disposed."],
      );
    }

    let session: SidekickSession;
    try {
      session = await this.getSession();
    } catch (error) {
      failed = true;
      const detail =
        error instanceof SidekickError ? error.message : "Failed to create the sidekick session.";
      return finish({ summary: "", changedFiles: [], tests: [], remainingIssues: [], reportFormat: "text" }, [detail]);
    }
    progress.sessionId = session.sessionId;
    if (signal?.aborted || this.disposed) {
      failed = true;
      return finish(
        { summary: "", changedFiles: [], tests: [], remainingIssues: [], reportFormat: "text" },
        [signal?.aborted ? "Sidekick call was aborted before it started." : "Sidekick has been disposed."],
      );
    }

    let lastText = "";
    try {
      const listener = (event: AgentSessionEvent) => {
        if (event.type === "turn_start") progress.turns++;
        if (event.type === "tool_execution_start") {
          progress.toolCalls++;
          if (event.toolName === "write" || event.toolName === "edit") progress.writeToolCalls++;
        }
        if (event.type === "message_end" && event.message.role === "assistant") {
          const delta = usageFromPi(event.message.usage);
          progress.usage = addUsage(progress.usage, delta);
          this.cumulativeUsage = addUsage(this.cumulativeUsage, delta);
          // Add all raw Usage numeric token fields + cost category fields to a per-call raw Usage for the returned tool usage.
          // reasoning is a subset of output, never add it again to totalTokens.
          addRawUsage(callUsage, event.message.usage);
          const message = event.message;
          const model = session.modelRuntime?.getModel(message.provider, message.model)
            ?? (session.model?.provider === message.provider && session.model.id === message.model ? session.model : undefined);
          const recorded = captureCost(message.usage, model, session.modelRuntime?.getRegisteredProviderConfig(message.provider));
          progress.ratesConfigured = progress.ratesConfigured && recorded.ratesConfigured;
          if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
            failed = true;
            modelEndedBadly = true;
          }
        }
        if (
          event.type === "turn_start" ||
          event.type === "tool_execution_start" ||
          (event.type === "message_end" && event.message.role === "assistant")
        ) {
          emit();
        }
      };
      const unsubscribe = session.subscribe(listener);
      const onAbort = () => {
        aborted = true;
        failed = true;
        void session.abort().catch(() => undefined);
      };
      signal?.addEventListener("abort", onAbort);
      try {
        if (signal?.aborted || this.disposed) {
          onAbort();
        } else {
          await session.prompt(brief);
        }
      } finally {
        unsubscribe();
        signal?.removeEventListener("abort", onAbort);
      }
      lastText = session.getLastAssistantText() ?? "";
    } catch {
      failed = true;
      const extraIssues = [
        aborted
          ? "Sidekick call was aborted."
          : "Sidekick run failed; provider details were omitted to avoid exposing credentials.",
      ];
      return finish(
        { summary: "", changedFiles: [], tests: [], remainingIssues: [], reportFormat: "text" },
        extraIssues,
      );
    }

    const extraIssues: string[] = [];
    if (modelEndedBadly) {
      extraIssues.push("Sidekick model ended with an error or abort; the implementation needs review.");
    }
    if (aborted || signal?.aborted) extraIssues.push("Sidekick call was aborted.");
    return finish(parseReportText(lastText), extraIssues);
  }

  async dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.disposePromise = (async () => {
      const pending = this.sessionPromise;
      this.sessionPromise = undefined;
      let session: SidekickSession | undefined;
      if (pending) {
        try {
          session = await pending;
        } catch {
          session = undefined;
        }
      }
      try {
        await session?.abort();
      } catch {
        /* abort failure must not skip disposal */
      }
      session?.dispose();
      await this.tail.catch(() => undefined);
    })();
    return this.disposePromise;
  }
}

export async function createSidekickSession(ctx: ExtensionContext, modelName: string): Promise<AgentSession> {
  const split = modelName.indexOf("/");
  if (split < 1 || split === modelName.length - 1) throw new Error("Expected provider/model for sidekick");
  const provider = modelName.slice(0, split);
  const modelId = modelName.slice(split + 1);
  const credentials = new InMemoryCredentialStore();
  const stored = readStoredCredential(provider, join(getAgentDir(), "auth.json"));
  if (stored) await credentials.modify(provider, async () => stored);
  const modelRuntime = await ModelRuntime.create({
    credentials,
    modelsPath: join(getAgentDir(), "models.json"),
    modelsStore: new InMemoryModelsStore(),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const native = ctx.modelRegistry.getRegisteredNativeProvider(provider);
  if (native) modelRuntime.registerNativeProvider(native);
  const extra = ctx.modelRegistry.getRegisteredProviderConfig(provider);
  if (extra) modelRuntime.registerProvider(provider, extra);
  const model = modelRuntime.getModel(provider, modelId);
  if (!model) throw new Error("Configured sidekick model is not available");
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0, timeoutMs: 240000 } },
    cacheWarming: "off",
    transport: "sse",
  });
  const loader = new DefaultResourceLoader({
    cwd: ctx.cwd,
    agentDir: getAgentDir(),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    appendSystemPrompt: [SIDEKICK_GUIDANCE],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: ctx.cwd,
    agentDir: getAgentDir(),
    modelRuntime,
    model,
    thinkingLevel: "medium",
    settingsManager,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(ctx.cwd),
    tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
  });
  return session;
}
