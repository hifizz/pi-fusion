The retry helper and job worker have interacting asynchronous bugs. Fix `src/retry.ts` and `src/worker.ts`.

Contract:
- `retry(operation, options)` passes a 1-based attempt number to operation and awaits it. `attempts` is the maximum total attempts, a positive safe integer.
- `delayMs` defaults to 0 and must be finite and nonnegative.
- On a failed attempt, retry only if an attempt remains and `shouldRetry(error, attempt)` (default true) allows it. Before the next attempt await the injected `sleep(delayMs * 2 ** (attempt - 1))`. Do not sleep after the last attempt or an error classified as nonretryable.
- On exhaustion/rejection, throw the original last error object. Each invocation owns its attempt state; sequential and concurrent calls must not interfere.
- `processJobs(jobs, options)` runs jobs one at a time in input order, each through retry. Return one `{ok:true,value}` or `{ok:false,error}` result per job, preserving the error object. A failed job must not prevent later jobs from running.

First reproduce with async failures and a fake sleep, then fix retry and verify the worker as a separate step. Preserve public signatures and run `npm test`. No new dependencies.
