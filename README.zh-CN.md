[English](README.md) | 简体中文

# pi-fusion

参照 Devin Fusion 的 **lead/sidekick** 模式为 Pi 编码代理(`pi` 1.4.0，`@earendil-works/pi-coding-agent`)编写的本地扩展，外加一套可复现的本地评测框架，用于验证该模式在小型编码任务上到底有没有收益。

- **fusion-lite 扩展**：lead 用 `sidekick` 工具委派实现；sidekick 是一个**持久**子会话，跨多次 brief 保留自己的上下文，只交换 brief/结果/反馈，保留两边可复用的 prompt 前缀；实际缓存命中由供应商决定。
- **评测框架**：每次 trial 在全新的沙箱临时目录中独立运行，结束后才拷入隐藏测试评分；按配置汇总通过率、token、估算成本、cost per solved。

## 状态

仅完成一次冒烟运行：1 个任务（`03-issue-summary`）× 4 个配置 × 1 次重复。四个配置均通过全部 8 项隐藏测试，但 `fusion-sol+glm` 达到 300 秒超时。数字仅为初步观测，不能作为有收益的证据。详见[冒烟报告](results/smoke-2026-10-28/report.md)。

## 环境要求

- Node.js 24（`engines: >=24 <25`，已用 v24.21.0 验证）
- pnpm 12.11.2（`packageManager` 锁定）
- Pi 1.4.0（`@earendil-works/pi-ai` / `@earendil-works/pi-coding-agent` 均固定为 `1.4.0`）

TypeScript 直接由 Node 原生 type stripping 运行（`erasableSyntaxOnly`），测试用 `node:test`，**不需要任何构建步骤**。

## 安装与日常命令

`pnpm-workspace.yaml` 已把 `storeDir`/`cacheDir` 两个路径固定到仓库内 `.cache/pnpm/`；其余写入位置随机器而定，因此本项目统一使用下面的严格本地环境（`--state-dir` 是 pnpm 支持的全局 CLI 覆盖）：

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

`ignoreScripts` 已开启，安装期不执行依赖脚本。不需要也不应改动 `~/.pi/agent` 或任何全局状态。

## 在 Pi 中启用扩展

一次性加载（推荐用法）：

```bash
pi -e /absolute/path/pi-fusion/src/index.ts --model magpie/codex/gpt-6.1-sol
```

sidekick 模型解析顺序（在**第一次**调用 sidekick 工具时解析一次）：

```
--fusion-sidekick-model <provider/model>  >  FUSION_SIDEKICK_MODEL  >  magpie/devin/swe-2（默认）
```

例如：`--fusion-sidekick-model magpie/zcode/GLM-5.3`。

本仓库 `package.json` 带 `pi.extensions` 元数据，因此在**消费方项目**中也可以用 `pi install --local /absolute/path/pi-fusion` 安装。这是可选项——本项目没有执行过该命令——它只修改那个消费项目自己的 Pi 包设置。**不要**全局安装扩展，也不要编辑 `~/.pi`。

直接调用 `pi` 时，主会话的存储行为遵循 Pi 自身实现；fusion-lite 的 sidekick 工作会话完全在内存中。评测不使用主会话状态，而是在隔离的本地副本中运行。

## 持久上下文是怎么工作的

- 每个活跃的 lead 运行时里，sidekick 懒加载创建**一个** SDK 子会话；同一子会话跨多次 brief 复用（FIFO 串行），只存在于内存中；主会话 shutdown/reload 后随之重置。
- 不向 sidekick 拷贝 lead 的整段对话，没有裁判模型，不按轮切换模型。
- 工具入参 `{brief: string}`；返回结构化报告（summary/changedFiles/tests/remainingIssues）+ 真实 `git diff --stat`（含 untracked 文件名）+ 当次与累计 token 用量。
- sidekick 最终输出不是合法 JSON 时，报告标记为 `reportFormat: "text"` 并在 `remainingIssues` 中写明“未验证”，**不会编造测试结果**。
- 中止/丢弃语义全部用 mock 单测覆盖，测试不包含任何真实（付费）模型调用。

## 评测

```bash
pnpm eval --dry-run                 # 只校验任务与配置，不调模型
pnpm eval:validate-tasks            # 自证：隐藏测试在参考答案上通过、在原始模板上失败

# 已交付冒烟产物（离线重新生成报告，不调模型）：results/smoke-2026-10-28/
pnpm report results/smoke-2026-10-28

# 新跑一份（需用户授权；输出目录必须不存在，runner 对已存在目录直接拒绝）
pnpm eval --configs 'sol-solo,fusion-sol+swe2,fusion-sol+glm,glm-solo' \
  --tasks 'evals/tasks/03-issue-summary' --repeats 1 --out results/my-smoke
pnpm report results/my-smoke
```

在这次冒烟中，两种 fusion 配置各调用 sidekick 两次，并复用同一个持久 worker 会话。`fusion-sol+glm` 的已知成本下界高于 `sol-solo` 的完整成本，本样本未显示该配置有成本优势；SWE-2 成本估算采用 Free-tier 假设。评测 CLI 因超时 trial 以 1 退出，JSONL 记录完整，未重试。

完整基准示例（**开发期间未运行**，仅示意）：

```bash
pnpm eval --configs 'sol-solo,fusion-sol+swe2,fusion-sol+glm,glm-solo' \
  --tasks 'evals/tasks/*' --repeats 3 --out results/full-example
```

注意：

- 开发期预算就是上面那**一次**冒烟（已用掉）；任何新的真实运行都必须先获得用户授权并使用全新输出目录。
- 输出目录已存在时 runner 拒绝运行；`--timeout-seconds` 默认 300。
- 失败的 trial 仍会写入 JSONL 记录；有失败/未通过时 CLI 以非零退出，`report` 仍照常生成。

### 任务集

8 个任务，均为纯 `node:test` 夹具、无第三方依赖、单次运行 < 1 分钟：

| 类型 | 任务 |
| --- | --- |
| 短小改动 ×2 | `01-clamp`、`02-slug` |
| 中等多文件 ×3 | `03-issue-summary`、`04-cart`、`05-event-bus` |
| bug 修复 ×2（含串行异步 debug） | `06-ttl-cache`、`07-job-retry` |
| 重构 ×1 | `08-log-stats` |

新增一个任务：`evals/tasks/<id>/` 下放

- `task.json`：`{"id":"09-example","type":"medium","description":"Example task","testCount":5}`（仅示意）
- `task.md`：给代理的需求
- `template/`：初始仓库模板（每次 trial 只拷它）
- `reference/`：参考实现（与模板 overlay）
- `hidden/*.test.mjs`：隐藏测试，用 `../src` 相对导入；`testCount` 必须与顶层测试数一致

### 新增配置 / 价格

- 配置写在 `evals/configs.ts`；付费运行前先用 `pi --list-models` 核实模型名。
- 价格写在 `evals/pricing.json`，每项含 `input`/`cachedInput`/`cacheWrite`/`output`/`source`/`asOf`，可手工修改。
- Kimi（如 `magpie/kimi/k3`）核实 ID 后可加为显式配置；目前**没有**被评测过，不要声称它参与过基准。

## 目录结构

```
src/index.ts      # 扩展入口：flag、sidekick 工具、引导注入、usage 条目
src/sidekick.ts   # PersistentSidekick + SDK 子会话工厂 + git 快照
src/prompts.ts    # lead/sidekick 行为准则与工具描述（稳定 prompt）
src/usage.ts      # token 归一化与累计
evals/            # 评测 CLI、runner、配置、价格表、报告
evals/tasks/      # 任务夹具（template/reference/hidden）
tests/            # 扩展单测 + 评测指标/文件系统隔离/extension loader 检查（全程无模型调用）
docs/NOTES.md     # Pi API 依据、隔离机制、指标语义、价格假设、已知限制
```

## 安全边界

- 所有写入只在本仓库内；不改 `~/.pi/agent`、不 push、不发布、不 sudo。
- 不打印任何密钥；sidekick 凭据只从已选 `agentDir` **读入内存**，worker 侧 OAuth 刷新不会写回全局 auth。
- 真实评测与任务校验都要求 macOS `sandbox-exec`（无绕过回退），详见 docs/NOTES.md。
