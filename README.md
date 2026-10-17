# DeskMind harness（TypeScript）

DeskMind 的「想」：理解要求、计划、调工具、核对，在用户的 Mac 上把事做成。0.5 起分成四层（openjev
`docs/design/skills-layer-2026-10-18.md`）：

| 层 | 在这里 | 可以换成 |
|---|---|---|
| 运行时 | `src/runtime/`（前沿模型单循环，pi-agent-core）；`src/orchestrator/`（本地小模型多角色编排器） | Codex、Claude Code… |
| 技能层 | `src/skills/`（Agent Skills 标准：每份教程一个文件夹的 `SKILL.md`，加例子、检查和可执行规则） | — |
| 执行层 | `src/executor/`（看整台电脑、动手、把关；驱动有模拟桌面和 hands 真机两种） | hands 做成 MCP 服务 |
| 本地模型 | 网关的 `systemone` 后端接 DeskMind Brain | — |

三条底线，不管模型和运行时是什么：

1. **谎报完成为 0**：`finish done` 只是模型的说法，结束要经过独立的 `verify` 角色读终态；拿不到结论就不算做成。
2. **未经同意的改动为 0**：任务开始时的清单上的东西都是用户的；改用户的东西、往外发，执行层只认 app 用 Ed25519 签的同意凭证（一次性 / 本次任务里这个对象 / 以后都按这条），没有就拒绝并出一道挑战。后果类别由结构算下限，模型只能往上调。
3. **随时可以停**：锁屏、停止开关、超时、预算用完，都如实停下并记在回执里。

| 目录 | 内容 |
|---|---|
| `src/executor/` | `types.ts` 执行层契约（快照、观察、动作、后果类别、凭证）；`ledger.ts` 归属清单；`consent.ts` 挑战与凭证（签名 / 验签 / 三档范围 / 一次性）；`executor.ts` 把关（锁屏、过期观察、停止、下限 ⊔ 模型类别、验签）、回执、核对用的证据；`sim.ts` 模拟桌面（邮件、编辑器、浏览器、系统设置，用户窗口和任务窗口）；`hands.ts` 真机驱动，对接 hands 的 `deskmind_hands.executor` |
| `src/runtime/` | `loop.ts` 前沿配置的单循环：工具（看电脑、看窗口、动手、计划、文件能力、问用户、回答、读教程、结束），把关在 `beforeToolCall`，每步核对和原地打转在动作结果里，不核对不让结束在 `finishTurn`；`model.ts` pi-ai 模型；`scripted.ts` 测试用的脚本化模型 |
| `src/skills/` | `agentskills.ts` SKILL.md 文件夹的读写、按结构筛候选、模型选；`library.ts` 教材的学会 / 收下 / 用 / 修订 / 按归因停用，可执行规则在 `rules.ts` |
| `src/orchestrator/` | 本地配置的编排器：七个角色（goal / plan / bind / intent / choice / skill / verify / transform），运行日志折叠出状态 |
| `src/gateway/` | 模型网关：`openai`（任何 OpenAI 兼容服务，`<provider>|<model>`，key 只从环境变量来）、OpenRouter、本地 mlx、Brain 的 systemone、`claude -p`（只在开发时）、脚本化（测试） |
| `src/registry/` | 工作目录（资源版本）与文件能力 |
| `src/protocol/` | 协议对象、各角色回答的 zod schema、给 app 的事件协议 |
| `src/cli/` | app 的入口（见下） |
| `src/eval/` | 检查集 / 考卷的跑分（两个引擎：`--engine orchestrator|runtime`），练习场 `gym.ts`（模拟桌面上的邮件任务，按应用真实状态判分） |
| `skills/` | 自带的基础技能 `deskmind-computer-use` |
| `test/` | 守护测试：脚本化的对抗模型，验证每一道保护；`executor.test.ts`、`runtime.test.ts` 专测三条底线 |

```bash
pnpm install
pnpm test                                                      # 228 项，不用模型
pnpm typecheck
YY_URL=… YY_API_KEY=… pnpm gym -- --config yy-luna --seeds 1-40  # 练习场：邮件任务 × 真实模型，判分看应用真实状态
pnpm eval -- --tasks <tasks-check.json> --config yy-luna --split check                  # 编排器
pnpm eval -- --engine runtime --tasks <tasks-check.json> --config yy-luna --split check # 新运行时，同一批题同一评分
pnpm eval -- --report runs/a/results.jsonl runs/b/results.jsonl                        # 并排比较
```

模型配置在 `src/gateway/index.ts` 的 `CONFIGS`（`yy-luna`、`yy-sol`、`yy-mix`、`B0-luna`、`dev-claude`）；`--role goal=openai:yy|gpt-6.1-sol` 可以单独换一个角色。

## 给 app 用的入口和打包（0.5）

`src/cli/app.ts` 是 DeskMind Hands.app 启动的子进程：事件先写进运行记录（`runs/app/<run_id>/events.jsonl`，带 `seq`，先落盘再发），再以每行一个 JSON 写到 stdout；卡片的回答从 stdin 读回来（`{"ask_id": …, "option": n}` 或 `{"ask_id": …, "text": "…"}`）。事件协议在 `src/protocol/events.ts`（start / preparing / plan / step / ask / waiting / resumed / consent / refused / answer_given / task_done），app 不认识的种类直接忽略。

```bash
echo '{"raw":"开一个编辑器窗口，新建文档，写上「你好」","config":"yy-luna"}' | pnpm app app-run     # 事件流在 stdout
pnpm app --selftest                                   # 不用模型：执行层 + 一轮脚本化的运行时，输出 {"ok":true,…}
pnpm bundle && node dist/harness.mjs --selftest       # esbuild 打成单文件（约 1.6 MB），基础教程在打包时嵌入
DESKMIND_MACTOOLS=/path/to/mactools                   # app 带预编译的 Swift 小工具时指过去，不再在用户机器上现编
```

Node 固定 `>=22.19`（pi 的要求），本机用 `.node-version` 里的 24。
