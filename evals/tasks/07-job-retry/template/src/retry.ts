export interface RetryOptions {
  attempts: number;
  delayMs?: number;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  sleep?: (milliseconds: number) => Promise<void>;
}
let attempt = 0;
export async function retry<T>(operation: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  while (attempt++ < options.attempts) {
    try {
      return operation(attempt);
    } catch (error) {
      if (options.shouldRetry && !options.shouldRetry(error, attempt)) throw error;
      await sleep((options.delayMs ?? 0) * 2 ** attempt);
    }
  }
  throw new Error("No attempts remaining");
}
