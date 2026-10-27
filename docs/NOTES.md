# NOTES — Pi API 依据、设计与隔离、指标语义、价格假设、已知限制

本文档只记录已核实的事实；不含臆测数字。

## 0. 已完成的验证

- 27/27 离线单测/集成检查通过（`node --test`，含 SDK 构造与 Jiti 扩展加载的真实无推理校验）。
- 8 个任务的「参考答案通过、模板失败」验证全部完成（交付快照为 `docs/TASK-VALIDATION.json`，期望计数 5,5,8,8,8,7,7,7）。
- 真实冒烟已完成且仅有一次：`03-issue-summary` × 4 配置 × 1 repeat（`results/smoke-2026-10-28/`）。四配置隐藏测试均 8/8；两种 fusion 配置在运行 JSON 中可见各 2 次 sidekick 调用复用同一持久 worker 会话；`fusion-sol+glm` 在 300s 超时，其成本仅为下界（完整总量未知），CLI 因超时以 1 退出、记录完整、无重试。
- 报告口径：JSON 中不完整 run 的完整成本保持 `null`；Markdown 以 `≥` 展示已知成本下界，且当下界已超过某个完整 solo 基线时允许给出「无成本优势」的结论。
- SWE-2/GLM 的正常配置工厂路径已被真实执行验证；非标准的运行时级 auth 覆盖等边角路径仍未验证。

## 1. 环境

- Node.js `>=24 <25`（实测 v24.21.0），pnpm `12.11.2`，Pi 依赖固定 `@earendil-works/pi-ai@1.4.0` 与 `@earendil-works/pi-coding-agent@1.4.0`。
- TypeScript 不构建：Node 24 原生 type stripping 直接跑 `.ts`（`allowImportingTsExtensions` + `erasableSyntaxOnly` 保证语法可擦除），测试用 `node:test`。
- `pnpm install && pnpm typecheck && pnpm test` 即可复现；无全局 Pi 改动需求。
- **pnpm 路径治理**（pnpm 12 实测）：
  - `pnpm-workspace.yaml` 承载 `storeDir`/`cacheDir`/`enableGlobalVirtualStore`/`ignoreScripts`/`updateNotifier`；其中 `storeDir`/`cacheDir` 固定指向 `.cache/pnpm/`；pnpm ≥10 起这些 key 放在 `.npmrc` 里会被忽略（已用 `pnpm config list` 与 `pnpm store path` 验证）。
  - `stateDir` 在 pnpm 12 是**机器级**配置：项目 `pnpm-workspace.yaml` 中会被明确拒绝（warning：ignored），`.npmrc` 中的 `state-dir=` 同样不生效，`npm_config_state_dir` 环境变量也不进入 `pnpm config list` 的解析结果；受支持的方式是全局 CLI 标志 `--state-dir=<dir>`。
  - 本项目只能固定 store/cache 两个路径，其余写入位置随机器而定，因此本会话的安装一律使用 README 给出的本地 `TMPDIR`/`XDG_CACHE_HOME`/`COREPACK_HOME`/`PNPM_HOME`/`npm_config_cache` 环境变量与 `--state-dir` 标志；不能断言裸 `pnpm` 命令在任何机器上都不写仓库外。
  - `updateNotifier=false` 下 `install`/`typecheck`/`test` 在本机实测不产生 state 文件（`~/.local/state/pnpm/pnpm-state.json` mtime 未变）。

## 2. Pi 扩展 API 依据

实现前阅读（不要凭记忆写 API）：

- 文档：`node_modules/@earendil-works/pi-coding-agent/docs/` 下 `extensions.md`、`sdk.md`、`json.md`、`environment-variables.md`、`cli.md`
- 类型：`dist/core/sdk.d.ts`、`dist/core/model-runtime.d.ts`、`dist/core/model-registry.d.ts`、`dist/core/resource-loader.d.ts`、`dist/core/agent-session.d.ts`、`dist/core/extensions/types.d.ts`、`pi-ai/dist/types.d.ts`

关键事实：

- 扩展入口为 `export default function (pi: ExtensionAPI)`；`pi` 是 `ExtensionAPI`。
- `ctx.modelRegistry` 是兼容外观（facade），**不是** `ModelRuntime`，不能强转。worker 侧必须用 `ModelRuntime.create(...)` 自建 runtime。
- SDK 工厂形状：`ModelRuntime.create({credentials, modelsPath, modelsStore, refreshOnCreate:false, allowModelNetwork:false})`；`InMemoryCredentialStore`/`InMemoryModelsStore` 来自 `@earendil-works/pi-ai`；`readStoredCredential(provider, join(getAgentDir(),'auth.json'))` 把所选 agentDir 的凭据**读入内存**——worker 侧 OAuth 刷新不会写回全局 `auth.json`。
- 原生 provider 用 `modelRuntime.registerNativeProvider(native)`（实测签名：`registerProvider(providerId, config)` 只接受扩展配置，`registerProvider(native)` 会编译失败）；扩展 provider 配置用 `modelRuntime.registerProvider(provider, extra)`。两者来自 `ctx.modelRegistry.getRegisteredNativeProvider / getRegisteredProviderConfig`。
- `DefaultResourceLoader` 以 `noExtensions/noSkills/noPromptTemplates/noThemes/noContextFiles` 全禁发现，防止 worker 递归加载 fusion 扩展；`appendSystemPrompt: [SIDEKICK_GUIDANCE]` 注入 sidekick 行为准则；`SettingsManager.inMemory({compaction off, retry off, cacheWarming 'off', transport 'sse'})`；`SessionManager.inMemory(cwd)`。
- `createAgentSession` 返回 `{session}`；工具参数 `tools: ['read','bash','edit','write','grep','find','ls']`；`thinkingLevel: 'medium'`。
- `registerTool` 的 `execute(toolCallId, params, signal, onUpdate, ctx)`；返回值 `{content, details, structuredContent, usage, isError}`。
- `before_agent_start` 处理器返回 `{systemPrompt}` 可注入 lead 准则（实现里用 `includes` 防止重复注入）。
- `pi.appendEntry(customType, data)` 持久化自定义条目（运行中产生 `entry_appended` 事件，评测据此读 usage）；`session_shutdown` 用于幂等清理。
- print/json 模式在 `session_start` **之后**才订阅事件，因此评测遥测 readiness 应在 `before_agent_start` 处发出。扩展的输出守卫写在 stderr 上。

## 3. fusion-lite 设计

- 每个活跃 lead 运行时只懒建**一个** SDK 子会话；`run()` 用 promise 尾链串行化（失败不污染队列），同一子会话跨多次 brief 复用。
- 纯内存：不写 worker 会话文件；主会话 `session_shutdown` 后 abort+dispose（幂等，含“工厂在途”场景），之后新调用返回失败报告。
- 统计只认 `message_end` 里 role=assistant 的用量事件；`turn_start`/`tool_execution_start` 计数，`write`/`edit` 记 writeToolCalls；progress 回调只在上述三类事件与 run 结束时发出，不为 `message_update` 每个 token 出 JSONL。
- AbortSignal → `session.abort()`；已 abort 的 signal 不会建会话；已 abort/dispose 的调用返回 `failed` 报告并保留已计 token。
- 报告：`summary/changedFiles/tests/remainingIssues` 校验为 4 字段 JSON（容忍一个 ```` ```json ```` 围栏）；不合规则 `reportFormat:'text'` + “unverified”提示，**不编造 tests**。`changedFiles`/`diffStat` 用真实 `git status --porcelain -z -uall` 与 `git diff --no-ext-diff --stat HEAD --`（`execFileSync`、数组参数、无 shell、`GIT_OPTIONAL_LOCKS=0`、timeout 10s、maxBuffer 1MB、stderr 不回显）；untracked 路径显式列出；非 git 目录返回明确的“不可用”字符串而不是吞掉实现结果。
- provider 错误体不回显：统一报 `'Sidekick run failed; provider details were omitted to avoid exposing credentials.'`。

## 4. 评测与文件系统隔离

- 真实评测**以及**参考校验都要求 macOS `sandbox-exec`，没有无沙箱回退。
- 每次 trial 用全新 `.work/run-*` 目录：只拷 `template/` 并 `git init`；沙箱 profile 隐藏整个任务语料库/参考答案/历史输出/其他 workspace 的内容与目录枚举，禁止写活跃 run 之外的路径。文件元数据（stat/realpath）刻意放行——Node 模块解析需要它；不声称文件名在 syscall 级不可见。
- 子进程内全局 Pi 配置路径读权限被拒绝；选中的 provider/auth 以 `mode 600` 拷入并在 `finally` 删除。
- 隐藏测试只在 Pi 退出**之后**才拷入独立的 grading workspace——即使残留的模型子进程也无法访问。
- 所有临时文件都在仓库内；父进程记录**脱敏**事件（流式文本 delta 正文省略），出错/超时也保留记录。
- 明确声明：这不是对恶意 Node 源码的防御——不能防住“代码伪造自己的运行时/测试进程”；任务集是可信的小型编码任务，不做敌对代码评分声明。
- 测试启动限制：macOS 不允许在 Seatbelt 内再 `sandbox_apply` 一层，因此最终门禁中 `install`/`typecheck` 在外层写限制 profile 下通过，而 `pnpm test` 不带外层 wrapper 运行（27/27 通过）；eval 测试自身的三个子沙箱隔离检查仍正常启用并通过。不为允许嵌套而改动沙箱规则。

## 5. 指标语义

- Pi 1.4 的 `usage.input` **不含** cached/cacheWrite；`output` 已含 reasoning（reasoning 不再二次计入 totalTokens）。
- 用量只认权威 `message_end`；worker 侧取该次调用的最后累计快照；lead 工具调用数取自父进程事件流；lead “亲自写文件”按评测遥测中成功的 write/edit 或改内容的 bash 计，不含 sidekick——这是遥测计数不是 syscall 计数，写回相同内容的 shell 写不可见。
- cache 命中率 = `cachedInput / (input + cachedInput + cacheWrite)`；分母为 0 记 `null`。
- cost = Σ tokens × rate / 1e6，lead 与 sidekick 分开汇总；**cost per solved = 全部尝试（含失败）总花费 ÷ 通过的 task×repeat 数**；没有通过或成本未知记 `null`。
- 超时/中断 trial 的 token 是下界，不当作完整总量展示。
- 对比按相同 taskId+repeat 配对；不使用 LLM 裁判。
- diff 大小相对原始基线、在拷入隐藏测试**之前**度量（含新增文件）。
- 代理运行状态与隐藏测试正确性分开报告——超时的 run 也可能留下通过的代码。

## 6. 价格来源与假设

- `evals/pricing.json` 中每项的 `input`/`cachedInput`/`cacheWrite`/`output`/`source`/`asOf` 可手工改；sol 与 GLM 使用 2026-10-28 配置的 Pi 费率快照。`docs/PRICE-SOURCES.json` 是一份脱敏、冻结的来源样本，仅作 provenance 记录，不参与计费。
- **SWE-2 目前全为 0 的费率是显式假设**：Devin catalog 中普通 `swe-2-medium` 等为 `cost_tier: "Free"`（无 USD 价目），`-lightning` 变体才标价 $1/$0.1/$5（不同变体、不同价）。该假设认为 magpie 转发的同一模型按普通 Free tier 计，**未验证网关实际计费**。所有成本对比都以可编辑估算为前提，报告必须对 free-tier 假设给出警示。
- provider 侧跨会话 prompt cache 不可重置/不可控；任务与 repeat 的执行顺序做轮换；冒烟是单一样本，不证明优劣。

## 7. 已知限制 / 未验证项

- sidekick 上下文不跨进程持久。凭据处理分两路：扩展 worker 侧只把凭据读入内存（不落盘）；评测 runner 则把选中的凭据文件拷入私有 `.work` 目录并在 finally 删除——两者都不写全局 auth。
- 运行时级 auth 覆盖、原生自定义 provider 等边角路径未做真机联调。
- 真实 runner 仅支持 macOS（`sandbox-exec`）。
- 成本是估算不是账单；任务为合成小型任务；并发写场景面向可信本地代码，无生产环境承诺。
