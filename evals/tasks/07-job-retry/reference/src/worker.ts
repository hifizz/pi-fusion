import { retry } from "./retry.ts";
import type { RetryOptions } from "./retry.ts";
export type JobResult<T> = { ok: true; value: T } | { ok: false; error: unknown };
export async function processJobs<T>(
  jobs: Array<(attempt: number) => Promise<T>>, options: RetryOptions,
): Promise<Array<JobResult<T>>> {
  const results: Array<JobResult<T>> = [];
  for (const job of jobs) {
    try { results.push({ ok: true, value: await retry(job, options) }); }
    catch (error) { results.push({ ok: false, error }); }
  }
  return results;
}
