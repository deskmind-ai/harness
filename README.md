# DeskMind harness（TypeScript）

DeskMind 能力编排运行时的 TypeScript 实现：按《能力编排架构与执行协议设计》2.0 的首版切片，从 openjev
`experiments/harness-b0`（Python，B0 基线评测用）移植。私有工作仓库。

闭环：目标结构化 → 找能力 / 教材 → 计划 → 参数绑定 → 意图核对 → 执行 → 验收 → 写教材并准入 → 复用 → 用错了就改。
七个模型角色（goal / plan / bind / intent / choice / skill / verify）各是一个可插拔的 profile，角色 → 模型的表在
`src/gateway/index.ts` 的 `CONFIGS`。

| 目录 | 内容 |
|---|---|
| `src/protocol/` | 协议对象与各角色回答的 zod schema。类型、运行时校验、JSON Schema 三者同源 |
| `src/gateway/` | 模型网关：OpenRouter（json_schema 输出、按 usage.cost 记账）、`claude -p`（本地开发）、脚本化（测试）；回复结果 answered / refusal / invalid / error / timeout |
| `src/registry/` | 工作目录（资源版本）与文件能力（描述、输入 schema、效果类、前置条件、执行、丢回执后的核实）；`tools.ts` 是用工具生成新文件的能力：模型改写文字（翻译、总结）、压缩成 zip、转 PDF、识别图片文字（后两个用 macOS 自带的工具，`native/mactools.swift` 首次使用时编译） |
| `src/orchestrator/` | 运行日志（追加、fsync、状态从日志折叠）、编排器、提示词 |
| `src/skills/` | 教材：skills2 规则语言（正则 + 模板，模型写规则、代码执行），自带检查（expect：哪些文件归它管、新文件名什么样、别的文件不动）；教材库、教学与准入；每次使用都记下，用错但最后做对的成了反例，强模型写新版，新旧两版在全部例子上由程序重放，新版不弄坏旧例子才换；只有用户这次的纠正和以前确认过的做法冲突时才问一句 |
| `src/gui/` | 受控的模拟编辑器（AX 风格元素、焦点 / 弹窗 / 布局干扰、适配器侧焦点守卫） |
| `src/eval/` | 跑 B0 评测集（任务文件在 openjev，按路径传入）和独立评分 |
| `test/` | 守护测试：脚本化的对抗决策方，在真实临时目录上验证每一道保护 |

```bash
pnpm install
pnpm test                                                      # 15 项守护测试 + 5 项规则测试
pnpm eval -- --tasks ../../gxcsoccer/openjev/experiments/harness-b0/evalset/tasks.json --config dev-claude --split dev --groups 1 --limit 2 -v
OPENROUTER_API_KEY=... pnpm eval -- --tasks <tasks.json> --config B0-luna --split dev --max-cost 3
```

与 Python 版的对应关系：同一份任务与金标准、同一条评分规则；六组题都能跑。差异只在实现语言，数字按组可比。

## 给 app 用的入口和打包（0.5）

`src/cli/app.ts` 是 DeskMind Hands.app 启动的子进程：事件先写进运行记录（`runs/app/<run_id>/events.jsonl`，带 `seq`，先落盘再发），再以每行一个 JSON 写到 stdout；卡片的回答从 stdin 读回来（`{"ask_id": …, "option": n}` 或 `{"ask_id": …, "text": "…"}`）。事件协议在 `src/protocol/events.ts`（start / preparing / plan / step / ask / waiting / resumed / consent / refused / answer_given / task_done），app 不认识的种类直接忽略。

```bash
echo '{"raw":"开一个编辑器窗口，新建文档，写上「你好」","config":"yy-luna"}' | pnpm app app-run     # 事件流在 stdout
pnpm app --selftest                                   # 不用模型：执行层 + 一轮脚本化的运行时，输出 {"ok":true,…}
pnpm bundle && node dist/harness.mjs --selftest       # esbuild 打成单文件（约 1.6 MB），基础教程在打包时嵌入
DESKMIND_MACTOOLS=/path/to/mactools                   # app 带预编译的 Swift 小工具时指过去，不再在用户机器上现编
```

Node 固定 `>=22.19`（pi 的要求），本机用 `.node-version` 里的 24。
