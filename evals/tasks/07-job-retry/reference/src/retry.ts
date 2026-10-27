export interface RetryOptions {
  attempts: number;
  delayMs?: number;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  sleep?: (milliseconds: number) => Promise<void>;
}
export async function retry<T>(operation: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  const delayMs = options.delayMs ?? 0;
  if (!Number.isSafeInteger(options.attempts) || options.attempts < 1
    || !Number.isFinite(delayMs) || delayMs < 0) throw new RangeError("Invalid retry options");
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (attempt >= options.attempts || (options.shouldRetry && !options.shouldRetry(error, attempt))) throw error;
      await sleep(delayMs * 2 ** (attempt - 1));
    }
  }
}
