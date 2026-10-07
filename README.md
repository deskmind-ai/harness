# DeskMind harness（TypeScript）

DeskMind 能力编排运行时的 TypeScript 实现：按《能力编排架构与执行协议设计》2.0 的首版切片，从 openjev
`experiments/harness-b0`（Python，B0 基线评测用）移植。私有工作仓库。

闭环：目标结构化 → 找能力 / 教材 → 计划 → 参数绑定 → 意图核对 → 执行 → 验收 → 写教材并准入 → 复用。
七个模型角色（goal / plan / bind / intent / choice / skill / verify）各是一个可插拔的 profile，角色 → 模型的表在
`src/gateway/index.ts` 的 `CONFIGS`。

| 目录 | 内容 |
|---|---|
| `src/protocol/` | 协议对象与各角色回答的 zod schema。类型、运行时校验、JSON Schema 三者同源 |
| `src/gateway/` | 模型网关：OpenRouter（json_schema 输出、按 usage.cost 记账）、`claude -p`（本地开发）、脚本化（测试）；回复结果 answered / refusal / invalid / error / timeout |
| `src/registry/` | 工作目录（资源版本）与文件能力（描述、输入 schema、效果类、前置条件、执行、丢回执后的核实） |
| `src/orchestrator/` | 运行日志（追加、fsync、状态从日志折叠）、编排器、提示词 |
| `src/eval/` | 跑 B0 评测集（任务文件在 openjev，按路径传入）和独立评分 |
| `test/` | 守护测试：脚本化的对抗决策方，在真实临时目录上验证每一道保护 |

```bash
pnpm install
pnpm test                                                      # 15 项守护测试
pnpm eval -- --tasks ../../gxcsoccer/openjev/experiments/harness-b0/evalset/tasks.json --config dev-claude --split dev --groups 1 --limit 2 -v
OPENROUTER_API_KEY=... pnpm eval -- --tasks <tasks.json> --config B0-luna --split dev --max-cost 3
```

还没移植：教材库（skills2 规则语言、准入）和受控 GUI 模拟器；评测时第 4、5 组先跳过。
