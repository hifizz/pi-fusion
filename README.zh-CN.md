[English](README.md) | 简体中文

# pi-fusion

pi-fusion 为 [Pi 编码代理](https://github.com/earendil-works/pi) 增加一个持久 sidekick，参考 [Devin Fusion](https://cognition.com/blog/devin-fusion) 的 lead + sidekick 协作方式。lead 模型负责计划和审查，单独配置的 sidekick 负责实现，并在多次请求间保留上下文。仓库还提供本地评测框架，用小型编码任务比较这种协作方式与单模型的表现。

**状态：** 仅完成一次冒烟运行：1 个任务 × 4 个配置 × 1 次重复；四个配置均通过 8/8 项隐藏测试，但 `fusion-sol+glm` 达到 300 秒超时。这不能作为有收益的证据。详见[冒烟报告](results/smoke-2026-10-28/report.md)。

## 安装

**仍在积极开发中。** pi-fusion 尚未发布到 Pi 包生态（npm），目前请按下面的步骤手动安装。发布后，就可以用一行命令 `pi install npm:pi-fusion` 安装。

需要 Node.js 24、pnpm 12.11.2 和 Pi 1.4.0，无需构建。

```bash
git clone https://github.com/hifizz/pi-fusion.git
cd pi-fusion
pnpm install
pi -e "$PWD/src/index.ts" --model '<provider>/<model>' \
  --fusion-sidekick-model '<provider>/<model>'
```

将占位符替换为 lead 和 sidekick 的模型 ID（见“使用”）。`-e` 只为本次 Pi 启动加载扩展。

如果想在某个使用此扩展的项目中持续启用，请在该项目里选择以下**一种**方式：

```bash
# 使用已执行 pnpm install 的本地克隆
pi install --local /absolute/path/pi-fusion
# 或由 Pi 从 GitHub 安装（两种来源格式均支持）
pi install --local git:github.com/hifizz/pi-fusion
pi install --local https://github.com/hifizz/pi-fusion
```

`--local` 将包记录到该项目的 `.pi/settings.json`；Pi 提示时需授予项目信任。本地路径直接引用你的克隆。以上来源格式均已对照 Pi 1.4.0 安装包中的文档、类型声明和 `pi install --help` 确认。

**npm 发布后（未来）：** `pi install npm:pi-fusion`。加上 `--local` 可安装到当前项目。这是 Pi 支持的包安装语法，当前还没有可用的 npm 发布版本。

## 使用

lead 使用 Pi 原有的 `--model '<provider>/<model>'`。sidekick 用 `--fusion-sidekick-model '<provider>/<model>'` 或 `FUSION_SIDEKICK_MODEL` 指定，命令行参数优先。**没有默认 sidekick 模型**：两者都未设置时，首次调用 sidekick 会报出配置提示。选定的模型在该 Pi 运行时内保持不变。

```bash
pi --list-models
FUSION_SIDEKICK_MODEL='<provider>/<model>' \
  pi -e /absolute/path/pi-fusion/src/index.ts --model '<provider>/<model>'
```

从 `pi --list-models` 中选取 ID，并在 Pi 中配置相应凭据。随后给 Pi 一个编码任务，lead 就可以通过 `sidekick` 工具委派实现。

## 查看花了多少

在 Pi 内运行 `/fusion-cost` 可查看当前会话（含恢复/重载的会话）已记录的 lead 与 sidekick token 数和估算 USD 成本。页脚会随每轮更新，形如 `fusion: lead $0.01 · sidekick $0.00`。

跨会话汇总在本仓库中运行：

```bash
pnpm fusion:costs
pnpm fusion:costs --since 2026-10-01
pnpm fusion:costs --dir /path/to/sessions --json
```

它以只读方式扫描 Pi 会话文件，输出逐会话表格和总计。USD 是按各模型已配置的 Pi 费率得出的估算而非账单；没有记录成本或费率的用量显示为 unknown，绝不当作免费。

## 运行评测

真实评测需要 macOS（`sandbox-exec`），可能产生模型费用。先运行 dry-run，它不会调用模型。

将 `evals/models.example.json` 复制为 `evals/models.local.json`，把值改成 `pi --list-models` 中的 ID。本地文件已被 gitignore 忽略，只控制评测模型，不配置交互式扩展。缺少值或仍含 `<provider>` 占位符时会明确报错。

| 配置 | lead 模型键 | sidekick 模型键 |
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

用逗号分隔配置 ID，通过任务路径或 glob 选择任务，用 `--repeats N` 设置重复次数。输出目录必须是新的。失败或超时的 trial 仍保存结果；即使评测以非零退出，也应运行 `pnpm report`。比较成本前，请按自己的模型和供应商核对 `evals/pricing.json` 中的估算；SWE-2 的零价是未经实际账单验证的 Free-tier 假设。

## 交给你的 AI 代理试用

把下面的提示词复制给编码代理：

```text
请在我选择的工作目录中帮我试用 pi-fusion。
1. 克隆 https://github.com/hifizz/pi-fusion.git（或使用已有克隆），
   阅读 README.zh-CN.md 和 docs/NOTES.md，然后运行 pnpm install。
2. 用 pi --list-models 查找模型 ID；如果我尚未指定模型，先问我。
   仅在 evals/models.local.json 不存在时从 evals/models.example.json 创建，
   填入模型 ID，不要覆盖已有的本地配置。
3. 运行 pnpm eval --dry-run。如果尚未获得付费模型调用授权，
   在这里停下，先询问我是否运行真实冒烟评测。
4. 获得授权后，只对一个任务运行四个配置，每个一次，不重试：
   pnpm eval --configs 'sol-solo,fusion-sol+swe2,fusion-sol+glm,glm-solo' --tasks 'evals/tasks/03-issue-summary' --repeats 1 --out results/my-smoke
   如果输出目录已存在，请选择另一个全新目录。
5. 即使评测以非零退出，也对同一输出目录运行 pnpm report。
   总结隐藏测试通过情况、超时或错误、耗时和估算成本，
   说明用量是否完整、价格假设，以及样本量的局限。
按 docs/NOTES.md 中的沙箱环境设置，将所有写入限制在克隆目录内。
不要修改全局 Pi 设置、打印凭据、push 或发布。
```

开发时运行 `pnpm typecheck && pnpm test`。严格的本地写入环境、任务夹具、隔离机制、定价和实现细节见[开发说明](docs/NOTES.md)。
