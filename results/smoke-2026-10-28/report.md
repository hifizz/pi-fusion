# pi-fusion 评测报告

生成时间：2026-10-27T20:19:35.317Z

**样本与任务覆盖有限，置信度不足。此报告描述固定小型任务的观测值，未做显著性检验；重复运行也不等于独立任务。不得外推生产任务表现。**

## 按配置汇总

| 配置 | 通过 / 次数 | 通过率 | 部分测试平均通过率 | 平均估算成本 | 每个通过任务成本 | 平均时间 s | 运行异常 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| fusion-sol+glm | 1/1 | 100.0% | 100.0% | ≥$0.145691 | ≥$0.145691 | 300.11 | 1 |
| fusion-sol+swe2 | 1/1 | 100.0% | 100.0% | $0.034121 | $0.034121 | 100.01 | 0 |
| glm-solo | 1/1 | 100.0% | 100.0% | $0.082537 | $0.082537 | 166.68 | 0 |
| sol-solo | 1/1 | 100.0% | 100.0% | $0.047809 | $0.047809 | 60.35 | 0 |

成本是 USD 估算，使用本次运行保存的 pricing.json；不是账单。费用缺失或中途终止导致用量不完整时用「≥」展示已记录且已定价部分的下界；未知部分不会当作免费。下界不是完整总额。
每个通过任务成本 = 所有尝试（含失败）的总成本 / 通过的任务×重复次数；零通过时无定义。

## 分模型用量

| 配置 | 角色 | 非缓存 input | cached input | cache write | output（含推理） | 缓存命中率 | 回合 | 工具调用 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| fusion-sol+glm | lead | 11189 | 38016 | 0 | 929 | 77.3% | 6 | 11 |
| fusion-sol+glm | sidekick | 16062 | 126272 | 0 | 12741 | 88.7% | 15 | 21 |
| fusion-sol+swe2 | lead | 10385 | 39808 | 0 | 937 | 79.3% | 6 | 7 |
| fusion-sol+swe2 | sidekick | 10155 | 70336 | 0 | 3900 | 87.4% | 14 | 19 |
| glm-solo | lead | 12123 | 92352 | 0 | 9671 | 88.4% | 13 | 17 |
| glm-solo | sidekick | 0 | 0 | 0 | 0 | — | 0 | 0 |
| sol-solo | lead | 8255 | 52992 | 0 | 2600 | 86.5% | 8 | 13 |
| sol-solo | sidekick | 0 | 0 | 0 | 0 | — | 0 | 0 |

缓存命中率按所有输入 token 加权；output 已含推理 token，不重复加计。只统计完成消息的用量，sidekick 使用每次调用的最后一份累计快照。

## 委派与改动

| 配置 | lead 写文件调用 | lead write/edit 调用（含尝试） | sidekick 调用 | diff 文件 / 增 / 删 |
| --- | ---: | ---: | ---: | ---: |
| fusion-sol+glm | 0 | 0 | 2 | 4 / +294 / -4 |
| fusion-sol+swe2 | 0 | 0 | 2 | 4 / +131 / -4 |
| glm-solo | 5 | 5 | 0 | 5 / +265 / -4 |
| sol-solo | 4 | 4 | 0 | 4 / +111 / -4 |

lead 写文件调用包括成功的 write/edit 和实际改变工作树内容的 bash 调用；sidekick 的修改不计入 lead。它衡量调用次数，不是系统调用或写入行数。

## 按任务类型分组

| 类型 / 配置 | 通过 / 次数 | 通过率 | 平均估算成本 | 每个通过任务成本 | 平均时间 s |
| --- | ---: | ---: | ---: | ---: | ---: |
| medium / fusion-sol+glm | 1/1 | 100.0% | ≥$0.145691 | ≥$0.145691 | 300.11 |
| medium / fusion-sol+swe2 | 1/1 | 100.0% | $0.034121 | $0.034121 | 100.01 |
| medium / glm-solo | 1/1 | 100.0% | $0.082537 | $0.082537 | 166.68 |
| medium / sol-solo | 1/1 | 100.0% | $0.047809 | $0.047809 | 60.35 |

## Fusion 与 sol-solo 的配对比较

| 配置 | 配对次数 | 平均成本差（Fusion − solo） | 成本降低比例 | 通过率差 |
| --- | ---: | ---: | ---: | ---: |
| fusion-sol+glm | 1 | — | — | 0.0 个百分点 |
| fusion-sol+swe2 | 1 | $-0.013688 | 28.6% | 0.0 个百分点 |

仅比较任务 ID 和重复编号完全一致的运行；不把不同任务难度造成的差异算作 Fusion 效果。

## 客观结论

- fusion-sol+glm：Fusion 已记录的估算成本下界不低于基线，本样本没有显示成本优势；最终总成本仍不完整。
- fusion-sol+swe2：本样本观测到成本降低且通过率未下降；不能据此推断总体优势。

样本与任务覆盖有限，置信度不足。此报告描述固定小型任务的观测值，未做显著性检验；重复运行也不等于独立任务。不得外推生产任务表现。

## 逐次运行

| 任务 | 配置 | 重复 | 状态 | 隐藏测试 | 成本 | 证据 |
| --- | --- | ---: | --- | ---: | ---: | --- |
| 03-issue-summary | sol-solo | 1 | completed | 8/8 | $0.047809 | 日志与 diff（仅本地） |
| 03-issue-summary | fusion-sol+swe2 | 1 | completed | 8/8 | $0.034121 | 日志与 diff（仅本地） |
| 03-issue-summary | fusion-sol+glm | 1 | timeout | 8/8 | ≥$0.145691 | 日志与 diff（仅本地） |
| 03-issue-summary | glm-solo | 1 | completed | 8/8 | $0.082537 | 日志与 diff（仅本地） |

原始逐次运行日志与 diff 仅保存在本地，不公开发布。

用量记录限制：

- Timeout: observed token usage is a lower bound
- An unfinished sidekick call may have unreported billed tokens
- Pi did not emit agent_settled; final usage may be missing

## 价格依据与假设

| 模型 | input | cached input | cache write | output | 日期 |
| --- | ---: | ---: | ---: | ---: | --- |
| magpie/codex/gpt-6.1-sol | 2 | 0.1 | 2.5 | 10 | 2026-10-28 |
| magpie/devin/swe-2 | 0 | 0 | 0 | 0 | 2026-10-28 |
| magpie/zcode/GLM-5.3 | 1.19516 | 0.29879 | 0 | 4.18306 | 2026-10-28 |

单价单位为 USD / 百万 token。

- magpie/codex/gpt-6.1-sol：Read-only snapshot of local Pi models.json, cost fields for this exact model。Configured estimates, not a billing statement; gateway charges may differ.

- magpie/devin/swe-2：Devin CLI models list --format json: swe-2-medium cost_tier=Free; local Pi magpie/devin/swe-2 also configures zero rates。Explicit estimate assuming the gateway forwards the ordinary Free-tier SWE-2. This is not verified gateway billing. SWE-2 Lightning is a different variant with $1 input/$0.1 cached/$5 output per million; replace these rates if the gateway charges.

- magpie/zcode/GLM-5.3：Read-only snapshot of local Pi models.json, cost fields for this exact model。Configured estimates, not a billing statement; gateway charges may differ.

**SWE-2 零价只在网关沿用普通 Free 档时成立，实际网关计费未验证。本文的成本比较以保存的价格表为条件；它不能证明真实账单会等额下降。**

缓存与顺序限制：每次使用新会话，但无法清空供应商缓存；跨运行缓存、执行顺序和服务负载可能影响成本与时间。

复现参数见 manifest.json；模型列表见 models.txt；全局 Pi 配置前后指纹见 config-integrity.json。
