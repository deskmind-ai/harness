# Brain 判官训练计划（2026-10-19 记录，待排期）

负责人 10-19 定：本轮本地化到此结束；Brain 的训练作为下一项记录在此，排期另定。

## 为什么训

本地化对比（`docs/localization-2026-10-19.md`）量到的唯一一处「本地比云端差」：Brain 做判官快档时，**界面任务上的意图题**它放行、云端会先问用户或拒——练习场 40 题影子核对 56 道意图题里 30 道不一致（27 道云端说「证据不够」、3 道「不一致」）；**核对题**它几乎只会说「不够」（检查集 99 次升级 97 次被云端推翻，练习场 13 次 fail 云端全判 pass）。现在靠按一致率路由把窗口意图题交回云端（一致率 75% → 93%），代价是本地占比 66% → 39%。训好了，这两类题能留在本地：界面任务本地占比回到六成以上，文件任务的核对题也能本地定。

## 样本（已产出，harness 侧）

- 来源：判官的 `judge.sample` 事件（`DESKMIND_JUDGE_SAMPLES=1` + `DESKMIND_JUDGE_SHADOW=1`）：每道两档都答过的题，带完整提示词（`P.choicePrompt` 的输出：材料 + 问题 + 选项）、选项 id、Brain 的答案与置信度、云端的答案。
- 汇总脚本：`scripts/judge-samples.py <run dirs> > samples.jsonl`（按提示词去重）。
- 已有：练习场 40 题 → **204 条**（意图 99、计划依据 65、核对 40；不一致 78：意图题 Brain 放行而云端「证据不够」40 / 「不一致」4、Brain 否决而云端放行 13、核对题 Brain fail 云端 pass 13、依据题 8）。文件 `runs/judge-samples-gym.jsonl`（不进仓库，已交负责人）。
- 已有（合并）：练习场 40 + 检查集 105 → **626 条**（意图 241、计划依据 244、核对 141；两档不一致 295 条）。文件 `runs/judge-samples-all.jsonl`（2.5 MB，不进仓库，已交负责人）。
- 再要更多：任何带 Brain 快档的运行开这两个开关即可；app 侧 `DESKMIND_JUDGE_SHADOW=0.1` 抽样后也会产出（量少、来自真实任务——隐私上这些材料是用户的窗口 / 文件内容，**只在本机用，不上传**）。

## 标签口径

- 标签 = 云端判官的答案（DeepSeek V4.1 Flash；更稳妥的是再用 luna 或 sol 复判一遍取多数）。云端也会错——文件任务上它和 Brain 一致 95%，分歧里有些是云端过谨慎（「证据不够」）；所以**不要把「证据不够」一律当正确标签**，先抽 30 条人工看一下云端分歧样本的对错，定下规则再训。
- 三类题分开看：意图（matches / mismatch / insufficient）、计划依据（r0… / 说不清）、核对（pass / fail / unknown）。核对题的提示词最长（含目录版本、回执、首末观察），Brain 现在基本答不了，可能要先裁剪材料（只给回执 + 首末观察的差异）再训。

## 训法（brain 仓库现有流程）

1. 样本转成 Brain 的协议形状：`{state: 材料, questions: {<题>: {type: "choice", criteria: {id: 描述}}}}` → 标签 `{answers: {<题>: {choice}}}`；选项描述就是 harness 的 option text。
2. 用仓库里的 LoRA 流程（`scripts/import_hands_dagger.py` 的数据组织 → `mlx_lm.lora` → `scripts/merge_lora.py`），底模是 app 里的 `fast`（Qwen3.5 系列 8-bit，`models/fast`）。
3. 评测：训练前后各跑一遍 harness 的影子核对（`DESKMIND_JUDGE_SHADOW=1`），看三类题的一致率和本地占比；holdout 用检查集的样本、训练用练习场的样本（或反过来），避免同题污染（brain 仓库有 `contamination_check.py`）。
4. 验收线：界面意图题一致率 ≥ 90%（现在 46%）、核对题放行率明显高于 2%，且练习场 40 题仍 40/40、谎报 0。
5. 门限：训后重新校准 0.9 这个门限（`scripts/judge-calibration.py`），不要沿用。

## 不做的

- 不用这些样本训动手模型（Brain 只会选不会写；动手模型本地化是另一个课题，30B 级本地生成模型负责人暂不排）。
- 不改契约：快档仍然只能放行、否决升云端——训练只是让它放行得更准更多。
