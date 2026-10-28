English | [简体中文](README.zh-CN.md)

# pi-fusion

pi-fusion adds a persistent sidekick to the [Pi coding agent](https://github.com/earendil-works/pi), inspired by [Devin Fusion](https://cognition.com/blog/devin-fusion)'s lead + sidekick pattern. Your lead model plans and reviews work while a separately configured sidekick implements it, keeping its context across requests. A local evaluation harness compares this setup with a single model on small coding tasks.

**Status:** One smoke run: 1 task × 4 configs × 1 repeat; all four passed 8/8 hidden tests, but `fusion-sol+glm` hit the 300-second timeout. This is not evidence of a benefit. [Smoke report](results/smoke-2026-10-28/report.md).

## Install

**Still in active development.** pi-fusion hasn't been published to the Pi package ecosystem (npm) yet, so please follow the manual installation steps below for now. Once published, you'll be able to install it with a single command: `pi install npm:pi-fusion`.

Use Node.js 24, pnpm 12.11.2, and Pi 1.4.0. No build step is needed.

```bash
git clone https://github.com/hifizz/pi-fusion.git
cd pi-fusion
pnpm install
pi -e "$PWD/src/index.ts" --model '<provider>/<model>' \
  --fusion-sidekick-model '<provider>/<model>'
```

Replace the placeholders with your lead and sidekick model IDs (see Usage). `-e` loads the extension for that invocation.

To keep it enabled in a consumer project, run **one** of these there:

```bash
# Use your existing clone after pnpm install
pi install --local /absolute/path/pi-fusion
# Or let Pi install it from GitHub (either source form works)
pi install --local git:github.com/hifizz/pi-fusion
pi install --local https://github.com/hifizz/pi-fusion
```

`--local` records the package in that project's `.pi/settings.json`; grant project trust when Pi asks. A local path stays linked to your clone. These source forms are supported by Pi 1.4.0's installed docs/types and `pi install --help`.

**After npm release (future):** `pi install npm:pi-fusion`. Add `--local` for a project install. This is the supported Pi package syntax, not an available release today.

## Usage

Use normal Pi `--model '<provider>/<model>'` for the lead. Choose the sidekick with `--fusion-sidekick-model '<provider>/<model>'` or `FUSION_SIDEKICK_MODEL`; the flag takes precedence. There is **no default sidekick model**: the first sidekick call fails with a setup message if neither is set. The selection stays fixed for that Pi runtime.

```bash
pi --list-models
FUSION_SIDEKICK_MODEL='<provider>/<model>' \
  pi -e /absolute/path/pi-fusion/src/index.ts --model '<provider>/<model>'
```

Pick IDs from `pi --list-models` and configure their credentials in Pi. Then give Pi a coding task; the lead can delegate through the `sidekick` tool.

## Run the evaluation

Real evaluations require macOS (`sandbox-exec`) and can incur model charges. Start with the dry run, which makes no model calls.

Copy `evals/models.example.json` to `evals/models.local.json`, then replace its values with IDs from `pi --list-models`. The local file is gitignored and controls evaluation models only; it does not configure the interactive extension. Missing values or `<provider>` placeholders cause a clear error.

| Config | Lead model key | Sidekick model key |
| --- | --- | --- |
| `sol-solo` | `gpt-6.1-sol` | — |
| `fusion-sol+swe2` | `gpt-6.1-sol` | `swe-2` |
| `fusion-sol+glm` | `gpt-6.1-sol` | `GLM-5.3` |
| `glm-solo` | `GLM-5.3` | — |

```bash
pnpm eval --dry-run
pnpm eval --configs 'sol-solo,fusion-sol+swe2,fusion-sol+glm,glm-solo' \
  --tasks 'evals/tasks/03-issue-summary' --repeats 1 --out results/my-smoke
pnpm report results/my-smoke
```

Choose comma-separated config IDs, a task path or glob, and `--repeats N`. Use a fresh output directory. Failed or timed-out trials still save results; run `pnpm report` even if evaluation exits nonzero. Review the estimates in `evals/pricing.json` for your models/provider before comparing costs; SWE-2's zero price is an unverified Free-tier assumption.

## Try it with your AI agent

Copy this prompt to your coding agent:

```text
Help me try pi-fusion in a working directory I choose.
1. Clone https://github.com/hifizz/pi-fusion.git (or use my existing checkout),
   read README.md and docs/NOTES.md, and run pnpm install.
2. Use pi --list-models to find IDs. Ask me which models to use if unspecified.
   Create evals/models.local.json from evals/models.example.json only if it is
   missing; set its model IDs without overwriting an existing local setup.
3. Run pnpm eval --dry-run. If paid model calls are not already authorized,
   stop here and ask before running the smoke evaluation.
4. Once authorized, run one task across the four configs, with no retries:
   pnpm eval --configs 'sol-solo,fusion-sol+swe2,fusion-sol+glm,glm-solo' --tasks 'evals/tasks/03-issue-summary' --repeats 1 --out results/my-smoke
   Choose a different fresh output directory if that one already exists.
5. Run pnpm report on that same directory even if evaluation exits nonzero.
   Summarize hidden-test passes, timeouts/errors, time, and estimated cost.
   State any incomplete usage or pricing assumptions and the sample-size limit.
Keep all writes inside the checkout using the sandbox setup in docs/NOTES.md.
Do not change global Pi settings, print credentials, push, or publish.
```

For development, run `pnpm typecheck && pnpm test`. See [development notes](docs/NOTES.md) for strict local-write setup, task fixtures, isolation, pricing, and implementation details.
