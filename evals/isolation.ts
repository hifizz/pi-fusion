import {
  chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { ROOT, localPath } from "./files.ts";
import { object } from "./metrics.ts";

export const PI_CLI = join(ROOT, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");

export function localEnvironment(workspace: string): NodeJS.ProcessEnv {
  const tmp = localPath(join(workspace, "tmp"));
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  const env = { ...process.env };
  // Do not load arbitrary Node/shell startup hooks into measured runs.
  for (const key of ["NODE_OPTIONS", "NODE_PATH", "BASH_ENV", "ENV", "FUSION_SIDEKICK_MODEL"]) delete env[key];
  return {
    ...env, TMPDIR: tmp, TMP: tmp, TEMP: tmp,
    XDG_CACHE_HOME: join(workspace, "cache"), XDG_STATE_HOME: join(workspace, "state"),
    npm_config_cache: join(workspace, "npm-cache"),
    npm_config_update_notifier: "false", COREPACK_HOME: join(workspace, "corepack"),
    PNPM_HOME: join(workspace, "pnpm"),
    JITI_FS_CACHE: join(workspace, "jiti"), PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
  };
}

/**
 * macOS Seatbelt applies to Pi AND its descendants. The agent cannot read the
 * fixture store, references, tests, previous results, or other runs. Grading
 * takes place in another workspace, outside this profile's readable subtree.
 */
export function sandboxCommand(workspace: string, command: string, args: string[]): {
  command: string; args: string[];
} {
  if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) {
    throw new Error("Real runs require macOS sandbox-exec; no unsandboxed fallback is permitted");
  }
  const work = realpathSync(localPath(workspace));
  const quoted = (path: string) => JSON.stringify(path);
  const readable = [
    join(ROOT, "node_modules"), join(ROOT, "src"), work,
  ].map((path) => `(subpath ${quoted(path)})`);
  readable.push(`(literal ${quoted(join(ROOT, "evals/telemetry.ts"))})`);
  readable.push(`(literal ${quoted(join(ROOT, "package.json"))})`);
  const globalPi = join(homedir(), ".pi", "agent");
  const profile = `(version 1)
(allow default)
(deny file-read-data (require-all (subpath ${quoted(ROOT)})
  (require-not (require-any ${readable.join(" ")}))))
(deny file-read* (subpath ${quoted(globalPi)}))
(deny file-write* (require-not (subpath ${quoted(work)})))
(allow file-write* (literal "/dev/null") (literal "/dev/tty"))
(deny file-write* (subpath ${quoted(join(work, "repo/.git"))}))
`;
  const path = join(work, "sandbox.sb");
  writeFileSync(path, profile, { mode: 0o600 });
  return { command: "/usr/bin/sandbox-exec", args: ["-f", path, command, ...args] };
}

/** No secret is written to result artifacts; these live in a private, disposable run directory. */
export function stagePiConfig(workspace: string, models: string[]): {
  agentDir: string; redact: (text: string) => string;
} {
  const source = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const readJson = (name: string) => {
    const path = join(source, name);
    try { return existsSync(path) ? object(JSON.parse(readFileSync(path, "utf8"))) : {}; }
    catch { throw new Error(`Cannot parse Pi ${name}; contents were not logged`); }
  };
  const configuration = readJson("models.json");
  const authentication = readJson("auth.json");
  const providers = object(configuration.providers);
  const wanted = new Map<string, Set<string>>();
  for (const model of models) {
    const split = model.indexOf("/");
    if (split <= 0) throw new Error("Expected provider/model");
    const provider = model.slice(0, split);
    const ids = wanted.get(provider) ?? new Set<string>();
    ids.add(model.slice(split + 1));
    wanted.set(provider, ids);
  }
  const selectedProviders: Record<string, unknown> = {};
  const selectedAuth: Record<string, unknown> = {};
  for (const [provider, ids] of wanted) {
    const config = object(providers[provider]);
    if (Object.keys(config).length) {
      const available = Array.isArray(config.models) ? config.models : [];
      selectedProviders[provider] = { ...config,
        models: available.filter((model) => ids.has(String(object(model).id))) };
    }
    if (authentication[provider]) selectedAuth[provider] = authentication[provider];
  }
  const agentDir = localPath(join(workspace, "agent"));
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  chmodSync(agentDir, 0o700);
  for (const [name, value] of Object.entries({
    "models.json": { providers: selectedProviders },
    "auth.json": selectedAuth,
    "settings.json": {
      compaction: { enabled: false }, cacheWarming: "off", transport: "sse",
      retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0, timeoutMs: 240_000 } },
      packages: [], extensions: [], skills: [], enableSkillCommands: false,
      defaultThinkingLevel: "medium",
    },
  })) writeFileSync(join(agentDir, name), JSON.stringify(value), { mode: 0o600 });
  return { agentDir, redact: createRedactor([selectedProviders, selectedAuth]) };
}

export function createRedactor(values: unknown[] = []): (text: string) => string {
  const secrets = new Set<string>();
  const remember = (value: unknown) => {
    if (typeof value !== "string" || value.length < 6) return;
    secrets.add(value);
    const resolved = process.env[value];
    if (resolved && resolved.length >= 6) secrets.add(resolved);
  };
  for (const [key, value] of Object.entries(process.env)) {
    if (/api.?key|token|secret|password|credential|authorization/i.test(key)) remember(value);
  }
  const walk = (value: unknown, sensitive = false) => {
    if (typeof value === "string") {
      if (sensitive) remember(value);
    } else if (Array.isArray(value)) {
      value.forEach((entry) => walk(entry, sensitive));
    } else if (value && typeof value === "object") {
      for (const [key, entry] of Object.entries(value)) {
        walk(entry, sensitive || /^(?:key|value)$|api.?key|token|secret|password|credential|authorization|headers|access|refresh/i.test(key));
      }
    }
  };
  values.forEach((value) => walk(value));
  const ordered = [...secrets].sort((a, b) => b.length - a.length);
  return (text: string) => {
    let safe = text;
    for (const secret of ordered) {
      safe = safe.replaceAll(secret, "[REDACTED]");
      const escaped = JSON.stringify(secret).slice(1, -1);
      if (escaped !== secret) safe = safe.replaceAll(escaped, "[REDACTED]");
    }
    return safe.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
      .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{16,}/g, "[REDACTED]");
  };
}

/** Store completed events; streaming text fragments are omitted to avoid split-secret leaks. */
export function safeEventLog(events: Record<string, unknown>[], redact: (text: string) => string): string {
  return events.map((event) => {
    if (event.type === "message_update") {
      return JSON.stringify({ type: event.type, usage: event.usage,
        assistantMessageEvent: { type: object(event.assistantMessageEvent).type } });
    }
    return redact(JSON.stringify(event));
  }).join("\n") + "\n";
}

export function globalPiFingerprint(): Record<string, string | null> {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return Object.fromEntries(["settings.json", "models.json", "auth.json"].map((name) => {
    const path = join(agentDir, name);
    return [name, existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null];
  }));
}
