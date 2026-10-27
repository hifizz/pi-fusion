# pi-fusion：任务书（给 devin-cli）

## 背景
Zilin 想给 Pi 编码代理（`pi` 1.4.0，npm 包 `@earendil-works/pi-coding-agent`，配置在 `~/.pi/agent/`）加一个参照 **Devin Fusion** 的功能，并且**用评测数据证明它到底有没有好处**（结论可能是"没有"，那也是有效结论）。

Devin Fusion 的机制（来源：https://cognition.com/blog/devin-fusion 、https://cognition.com/blog/local-fusion 、https://docs.devin.ai/cli/fusion）：
- 一个前沿 **lead** 模型 + 一个便宜 **sidekick** 模型，两者**各自保留持久上下文**，只交换 brief / 结果 / 反馈，不传整段对话，从而保住两边的 prompt cache。
- lead：和用户对话、计划、澄清、最终 review（通常只看 git diff），写带约束和完成标准的 brief。
- sidekick：探索代码、实现、跑测试并汇报。没有裁判模型；lead 发现问题就再发 brief 或自己接手。
- 不要按轮切换模型（会丢缓存）。

## 目标
在本目录 `~/side/pi-fusion` 建一个 TypeScript 包（pnpm，Node 24），包含两部分：

### A. Pi 扩展：fusion-lite
- 作为 Pi 扩展加载（`pi -e <path>` 或 `pi install` 本地路径，具体以 Pi 1.4.0 的类型声明 / 文档为准，**先读 `node_modules/@earendil-works/pi-coding-agent` 的 .d.ts 和 docs 再写**，不要凭记忆写 API）。
- 主会话模型 = lead。扩展注册一个 `sidekick` 工具：
  - 首次调用时用 SDK（如 `createAgentSession` 之类，以真实 API 为准）创建一个**常驻**子会话，模型可配置；之后的调用复用同一个子会话（持久上下文）。
  - 入参：brief（目标、约束、完成标准、相关文件）；返回：sidekick 的结构化汇报（改了哪些文件、测试结果、遗留问题）+ `git diff --stat`。
  - 记录 lead 与 sidekick 各自的 token 用量（input / cached input / output）。
- 一份 lead 行为准则（可作为扩展注入的 system 追加或 AGENTS.md 片段）：早委派、写规格级 brief、只看 diff 做 review、出问题再发 brief。
- sidekick 模型通过配置/环境变量指定，默认 `magpie/devin/swe-2`。

### B. 评测框架（重点）
- 命令：`pnpm eval --configs <a,b,...> --tasks <glob> --repeats N --out results/<timestamp>`，以及 `pnpm eval --dry-run`（不调模型，只校验任务和配置）。
- 评测任务集 `evals/tasks/<id>/`：每个任务是一个小型独立仓库模板 + `task.md`（给代理的需求）+ **隐藏测试**（代理运行期间不可见，结束后才拷进去跑）。至少 **8 个**任务，覆盖：
  - 2 个短小改动（预期 Fusion 不占优）
  - 3 个中等多文件功能
  - 2 个 bug 定位修复（含串行 debug）
  - 1 个重构
  任务尽量用 TypeScript，测试用 vitest 或 node:test，单次跑完 < 1 分钟。
- 每次运行在一个全新的临时目录（拷贝模板 + `git init`），通过 `pi -p --mode json` 非交互调用，带超时，`</dev/null`，结束后跑隐藏测试。
- 配置（模型名用 `pi --list-models` 核实，以下为预期）：
  1. `sol-solo`：lead 单独干，`magpie/codex/gpt-6.1-sol`
  2. `fusion-sol+swe2`：lead `magpie/codex/gpt-6.1-sol` + sidekick `magpie/devin/swe-2`（开扩展）
  3. `fusion-sol+glm`：lead `magpie/codex/gpt-6.1-sol` + sidekick `magpie/zcode/GLM-5.3`
  4. `glm-solo`：`magpie/zcode/GLM-5.3` 单独干（便宜基线）
  5. 可选 `swe2-solo`
  配置写在 `evals/configs.ts`，方便以后加 Kimi（如 `magpie/kimi/k3`）。
- 指标（每次运行一行 JSONL，汇总成表）：
  - 是否通过隐藏测试（通过率）、部分通过的测试比例
  - 墙钟时间、回合数、工具调用次数
  - token：lead / sidekick 分开的 input、cached input、output，及缓存命中率
  - **估算成本**：价格表放 `evals/pricing.json`（可参照 `devin models` 显示的单价，标注来源和日期，可手改）
  - lead 是否亲自改了代码（lead 写文件次数），sidekick 调用次数
  - diff 大小
- 报告：`pnpm report results/<dir>` 生成 `report.md`（+ `summary.json`）：按配置汇总通过率、平均成本、**每个通过任务的成本**（cost per solved task）、时间；按任务类型分组；对比 `fusion-*` vs `sol-solo` 的成本差与通过率差，并给出一句客观结论（含"没有优势"的情况）。样本少时要标注置信度不足。

## 约束
- 只在 `~/side/pi-fusion` 内写文件；不要改 `~/.pi/agent/` 下的全局配置、auth、已装扩展；不要 `git push`、不要发布 npm 包、不要 sudo。
- 不打印任何 API key / token。
- 真实模型调用要花钱：开发阶段只用 `--dry-run` 和**最多 1 个任务 × 各配置 × 1 次**的冒烟评测；不要自行跑完整评测。
- 先读 Pi 的类型声明和文档，API 不确定的地方在 `docs/NOTES.md` 里写明。

## 交付物
- 代码、`README.md`（安装、如何在 Pi 里启用扩展、如何跑评测、如何加模型/任务）
- `docs/NOTES.md`：用到的 Pi API、设计取舍、已知限制、未验证项
- 一次冒烟评测的结果目录 + 生成的 `report.md`
- git 提交（本地即可）
- 最后输出一段总结：完成了什么、验收清单逐条自检结果、冒烟评测的数字、未完成/风险项
