English | [简体中文](README.zh-CN.md)

# pi-fusion

A local extension for the Pi coding agent (`pi` 1.4.0, `@earendil-works/pi-coding-agent`), inspired by Devin Fusion's **lead/sidekick** pattern, with a reproducible local evaluation harness to test whether the pattern helps on small coding tasks.

- **fusion-lite extension**: the lead delegates implementation through the `sidekick` tool. The sidekick is a **persistent** child session that retains context across briefs. Only briefs, results, and feedback are exchanged, preserving reusable prompt prefixes on both sides; actual cache hits depend on the provider.
- **Evaluation harness**: each trial runs independently in a fresh sandbox directory. Hidden tests are copied in only after the agent finishes. Results summarize pass rates, tokens, estimated cost, and cost per solved task by configuration.

## Status

Only one smoke run has been completed: 1 task (`03-issue-summary`) × 4 configs × 1 repeat. All four configurations passed all 8 hidden tests, though `fusion-sol+glm` reached the 300-second timeout. The numbers are preliminary and are not evidence of a benefit. See the [smoke report](results/smoke-2026-10-28/report.md).

## Requirements

- Node.js 24 (`engines: >=24 <25`, verified with v24.21.0)
- pnpm 12.11.2 (pinned in `packageManager`)
- Pi 1.4.0 (`@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` are both pinned to `1.4.0`)

TypeScript runs directly through Node's native type stripping (`erasableSyntaxOnly`). Tests use `node:test`; **no build step is required**.

## Installation and everyday commands

`pnpm-workspace.yaml` pins `storeDir` and `cacheDir` under the repository's `.cache/pnpm/`. Other write locations vary by machine, so use the following environment to keep them local (`--state-dir` is pnpm's global CLI override):

```bash
mkdir -p .cache/tmp
export TMPDIR="$PWD/.cache/tmp"
export XDG_CACHE_HOME="$PWD/.cache"
export COREPACK_HOME="$PWD/.cache/corepack"
export PNPM_HOME="$PWD/.cache/pnpm-home"
export npm_config_cache="$PWD/.cache/npm"
pnpm --state-dir="$PWD/.cache/pnpm/state" install
pnpm typecheck
pnpm test
```

`ignoreScripts` is enabled, so dependency scripts do not run during installation. Do not change `~/.pi/agent` or other global state.

## Enable the extension in Pi

Load it for a single invocation (recommended):

```bash
pi -e /absolute/path/pi-fusion/src/index.ts --model magpie/codex/gpt-6.1-sol
```

The sidekick model is resolved once, on the **first** sidekick tool call, in this order:

```text
--fusion-sidekick-model <provider/model>  >  FUSION_SIDEKICK_MODEL  >  magpie/devin/swe-2 (default)
```

For example: `--fusion-sidekick-model magpie/zcode/GLM-5.3`.

The repository's `package.json` includes `pi.extensions` metadata, so you can also run `pi install --local /absolute/path/pi-fusion` in a **consumer project**. This optional command has not been run for this project; it changes only that consumer project's Pi package settings. **Do not** install the extension globally or edit `~/.pi`.

When invoking `pi` directly, the main session follows Pi's own storage behavior; fusion-lite's sidekick session stays entirely in memory. Evaluations use isolated local copies rather than main-session state.

## How persistent context works

- Each active lead runtime lazily creates **one** SDK child session. It is reused across briefs in FIFO order, lives only in memory, and resets when the main session shuts down or reloads.
- The lead's full conversation is not copied to the sidekick. There is no judge model or model switching between turns.
- The tool accepts `{brief: string}` and returns a structured report (`summary`/`changedFiles`/`tests`/`remainingIssues`), real `git diff --stat` output plus untracked filenames, and per-call and cumulative token usage.
- If the sidekick's final output is not valid JSON, the report uses `reportFormat: "text"` and records that it is unverified in `remainingIssues`; **test results are never invented**.
- Cancellation and disposal behavior are covered by mock unit tests. Tests make no real or paid model calls.

## Evaluation

```bash
pnpm eval --dry-run                 # Validate tasks and configs without model calls
pnpm eval:validate-tasks            # Check hidden tests pass on references and fail on templates

# Regenerate the existing smoke report offline, without model calls
pnpm report results/smoke-2026-10-28

# New run: requires user authorization and a fresh output directory
pnpm eval --configs 'sol-solo,fusion-sol+swe2,fusion-sol+glm,glm-solo' \
  --tasks 'evals/tasks/03-issue-summary' --repeats 1 --out results/my-smoke
pnpm report results/my-smoke
```

In that smoke run, each fusion configuration made two sidekick calls and reused one persistent worker session. The known cost lower bound for `fusion-sol+glm` exceeded the complete `sol-solo` cost, so this sample showed no cost advantage for that configuration. SWE-2 cost estimates assume the Free tier. The evaluation CLI exited with code 1 because of the timed-out trial; all JSONL records were saved and no retry was made.

Full benchmark example (**not run during development**, for illustration only):

```bash
pnpm eval --configs 'sol-solo,fusion-sol+swe2,fusion-sol+glm,glm-solo' \
  --tasks 'evals/tasks/*' --repeats 3 --out results/full-example
```

Notes:

- The development budget covered **one** smoke run and is exhausted. Any new real run requires user authorization and a fresh output directory.
- The runner rejects existing output directories. `--timeout-seconds` defaults to 300.
- Failed trials still produce JSONL records. The CLI exits with a nonzero status for errors or failed tests; reports can still be generated.

### Task set

Eight tasks use dependency-free `node:test` fixtures, each running in under a minute:

| Type | Tasks |
| --- | --- |
| Small changes ×2 | `01-clamp`, `02-slug` |
| Medium, multiple files ×3 | `03-issue-summary`, `04-cart`, `05-event-bus` |
| Bug fixes ×2, including debugging sequential async behavior | `06-ttl-cache`, `07-job-retry` |
| Refactoring ×1 | `08-log-stats` |

To add a task, create the following under `evals/tasks/<id>/`:

- `task.json`: e.g. `{"id":"09-example","type":"medium","description":"Example task","testCount":5}`
- `task.md`: the requirements given to the agent
- `template/`: the initial repository template, copied for each trial
- `reference/`: the reference implementation, overlaid on the template
- `hidden/*.test.mjs`: hidden tests using relative `../src` imports; `testCount` must match the number of top-level tests

### Add configurations or pricing

- Define configurations in `evals/configs.ts`. Verify model IDs with `pi --list-models` before paid runs.
- Edit prices in `evals/pricing.json`. Each entry includes `input`, `cachedInput`, `cacheWrite`, `output`, `source`, and `asOf`.
- Kimi (e.g. `magpie/kimi/k3`) can be added as an explicit configuration after verifying its ID. It has **not** been evaluated; do not claim it participated in the benchmark.

## Repository layout

```text
src/index.ts     # Extension entry: flags, sidekick tool, guidance injection, usage entries
src/sidekick.ts  # PersistentSidekick, SDK child-session factory, git snapshots
src/prompts.ts   # Lead/sidekick guidance and tool descriptions (stable prompts)
src/usage.ts     # Token normalization and accumulation
evals/           # Evaluation CLI, runner, configs, pricing, reports
evals/tasks/     # Task fixtures (template/reference/hidden)
tests/           # Extension tests, metrics, filesystem isolation, extension loading; no model calls
docs/NOTES.md    # Pi API references, isolation, metric semantics, pricing assumptions, limitations
```

## Safety boundaries

- Keep all writes inside this repository. Do not modify `~/.pi/agent`, push, publish, or use `sudo`.
- Never print credentials. The sidekick reads credentials from the selected `agentDir` into memory; worker OAuth refreshes do not write back to global auth storage.
- Real evaluations and task validation require macOS `sandbox-exec`, with no bypass fallback. See `docs/NOTES.md`.
