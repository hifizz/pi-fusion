import { retry } from "./retry.ts";
import type { RetryOptions } from "./retry.ts";
export type JobResult<T> = { ok: true; value: T } | { ok: false; error: unknown };
export async function processJobs<T>(
  jobs: Array<(attempt: number) => Promise<T>>, options: RetryOptions,
): Promise<Array<JobResult<T>>> {
  return Promise.all(jobs.map(async (job) => ({ ok: true as const, value: await retry(job, options) })));
}
