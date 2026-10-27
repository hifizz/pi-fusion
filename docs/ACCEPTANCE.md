# 验收清单（调度方会逐条核对）

1. `pnpm install && pnpm typecheck && pnpm test` 全部通过（扩展和评测框架都有单元测试，含隐藏测试拷贝、JSONL 解析、成本计算、报告汇总）。
2. `pnpm eval --dry-run` 列出 ≥8 个任务和 ≥4 个配置且无报错；每个任务的隐藏测试在**参考答案**上通过、在**原始模板**上失败（提供 `pnpm eval:validate-tasks` 自证）。
3. 扩展能在 Pi 里加载：`pi -p -e <扩展路径> --model magpie/codex/gpt-6.1-sol ...` 的 JSON 事件里能看到 `sidekick` 工具；同一会话两次调用 sidekick 复用同一子会话（有测试或日志证明）。
4. 运行期间代理看不到隐藏测试；每次运行在独立临时目录。
5. 冒烟评测：1 个中等任务 × `sol-solo` / `fusion-sol+swe2` / `fusion-sol+glm` / `glm-solo` × 1 次，全部跑完（失败也要有记录），生成 `report.md`，里面有通过率、lead/sidekick 分开的 token、估算成本、cost per solved task、时间。
6. `report.md` 的结论客观，样本不足时明确写出。
7. README 能让人照着复现；`docs/NOTES.md` 写清 Pi API 依据与未验证项。
8. 没有改动 `~/side/pi-fusion` 以外的文件，没有泄露密钥。
