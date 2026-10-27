/** Pi 1.4 usage.input excludes cacheRead/cacheWrite; output includes reasoning. */
export interface TokenUsage {
  input: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
}

export function emptyUsage(): TokenUsage {
  return { input: 0, cachedInput: 0, cacheWrite: 0, output: 0 };
}

function tokenCount(value: unknown, field: string): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid token count: ${field}`);
  }
  return value;
}

export function usageFromPi(value: unknown): TokenUsage {
  if (!value || typeof value !== "object") throw new Error("Missing Pi usage");
  const usage = value as Record<string, unknown>;
  return {
    input: tokenCount(usage.input, "input"),
    cachedInput: tokenCount(usage.cacheRead, "cacheRead"),
    cacheWrite: tokenCount(usage.cacheWrite, "cacheWrite"),
    output: tokenCount(usage.output, "output"),
  };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    cachedInput: a.cachedInput + b.cachedInput,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    output: a.output + b.output,
  };
}

export function cacheHitRate(usage: TokenUsage): number | null {
  const promptTokens = usage.input + usage.cachedInput + usage.cacheWrite;
  return promptTokens === 0 ? null : usage.cachedInput / promptTokens;
}
