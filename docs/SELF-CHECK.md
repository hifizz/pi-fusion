# ACCEPTANCE.md 逐条自检

日期：2026-10-28。真实评测仅执行 `03-issue-summary` × 4 配置 × 1 次，未执行全量评测或重跑。

| # | 结论 | 验证证据 |
| --- | --- | --- |
| 1 | 通过 | pnpm install、typecheck 通过；pnpm test 27/27 通过，覆盖扩展会话复用、中止、真实 SDK 无推理构造、隐藏测试拷贝、JSONL、成本和报告。成本下界展示的最后改动另有 2 个定向测试及 typecheck 通过。macOS 禁止嵌套 Seatbelt，测试启动方式见 NOTES。 |
| 2 | 通过 | dry-run 列出 8 任务、4 配置；8 个参考实现合计 55/55 隐藏测试通过，8 个原始模板均失败。可运行 `pnpm eval:validate-tasks` 自证；冻结结果见 TASK-VALIDATION.json。 |
| 3 | 通过 | 实际 Pi JSON 中两种 Fusion 各调用 sidekick 两次，每组只有一个 worker session ID；另有真实 Jiti 加载检查及持久会话单测。 |
| 4 | 通过 | 每次独立 `.work/run-*`；Seatbelt 阻止读取原始隐藏测试、参考答案和其他运行目录；Pi 退出后在另一独立目录复制隐藏测试评分。隔离行为有集成测试。 |
| 5 | 通过，含超时记录 | 四组均有完整结果行和报告。三组正常结束；fusion-sol+glm 达到 300 秒超时，保留已有 token 与成本下界。四组代码均通过 8/8 隐藏测试。 |
| 6 | 通过 | 报告明确小样本置信度不足、价格假设及跨运行缓存影响；GLM Fusion 已记录成本下界超过 solo，因此没有成本优势；SWE-2 观测优势以 Free 档估价为条件。 |
| 7 | 通过 | README 包含安装、扩展启用、评测、报告、添加任务/模型；NOTES 列出 Pi 1.4 API 依据、设计取舍、macOS 限制及未验证项。 |
| 8 | 通过 | 开发文件、依赖缓存与临时目录均在本仓库；没有修改全局 Pi 配置，没有 push、发布或 sudo。全局 settings/models/auth 前后指纹一致；交付文件的已知凭据匹配扫描为零；临时凭据与工作目录已删除。 |

## 冒烟数字

| 配置 | 隐藏测试 | 状态 | 墙钟秒 | 估算成本 USD / 每个通过任务成本 |
| --- | --- | --- | ---: | ---: |
| sol-solo | 8/8 | completed | 60.351 | 0.047809 |
| fusion-sol+swe2 | 8/8 | completed | 100.007 | 0.034121 |
| fusion-sol+glm | 8/8 | timeout | 300.108 | ≥0.145691 |
| glm-solo | 8/8 | completed | 166.677 | 0.082537 |

每组只有一次通过的任务，因此该组 cost per solved 与本次成本相同。GLM Fusion 的完整成本保持未知；表中只给已记录下界。SWE-2 以普通 Free 档转发假设计价，实际网关账单未验证。

SWE-2 Fusion 观测估算成本下降约 28.6%，但增加约 39.7 秒。两种 Fusion 的 lead 写文件调用均为 0，均通过两次 sidekick 调用完成实现。不能由单任务样本推断整体质量或生产成本收益。

完整分角色 token、缓存命中率、回合/工具调用、diff 和配对比较见 `results/smoke-2026-10-28/report.md`；每次 JSON 事件及测试输出位于对应子目录。`docs/AUDIT.json` 记录对事件用量、成本算式、会话复用、配置完整性和凭据扫描的独立核对结果。
