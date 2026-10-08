/**
 * Role prompts. The orchestrator never parses free text: every role answers in the JSON shape of its schema
 * (protocol/roles.ts), and the gateway validates it first.
 *
 * Source spans are given as an exact quote plus an occurrence; the runtime resolves the quote to code-point offsets in
 * the evidence and refuses quotes that are not there (2.0 §5.2).
 */
import type { Listing } from "../registry/workspace.js";
import type { Goal, PlanNode } from "../protocol/schemas.js";

export const SYSTEM =
  "你是桌面助手 DeskMind 里的一个决策函数。你只根据给出的材料回答，不假设没给出的事实。" +
  "你的回答是提议，由程序校验后才会执行；程序只会执行已注册的能力。只输出一个 JSON 对象。";

const J = (x: unknown) => JSON.stringify(x, null, 1);

export interface CapView { id: string; description: string; effect?: string; input?: unknown; required?: string[] }

const CHECKS_DOC = `可用的确定性检查（由代码执行，expected 里的值必须是用户原文里的原话或由原话直接确定）：
- file_exists {path}            指定路径存在
- file_absent {path}            指定路径不存在
- is_folder {path}              指定路径是文件夹
- text_equals {path, text}      文件全文等于 text（忽略末尾换行）
- text_contains {path, text}    文件包含 text
- last_line_is {path, line}     文件最后一行是 line，且 line 在文件里只出现一次
- same_text {path, other}       两个文件内容相同
- unchanged {path}              这个路径在任务期间不能被改动（用于「其他文件不动」这类约束）
- content_moved {from, to}      to 的内容等于移动前 from 的内容（移动 / 复制 / 改名后内容没变）
- last_line_is_content_of {path, source}   path 的末行等于 source 文件执行时的内容（「把 A 的内容追加到 B」用这个，不要把现在预览里看到的内容抄成常量）
- text_equals_content_of {path, source}    path 的内容等于 source 文件执行时的内容
值来自另一个文件时，一律用 *_content_of 引用那个文件；预览里的内容可能在执行前被改，抄成常量会把错的结果判成对。
检查写的是任务做完后的最终状态，不是中间步骤：「复制再追加一行」的结果文件不再等于源文件，就不能用 content_moved 去查它。
能用这些检查表达的都用 deterministic；semantic 只用于「看起来对不对」这类代码判断不了的要求。
path 是相对任务目录的路径；用户没说清楚的值不要编造，写进 missing。`;

export function goalPrompt(raw: string, answers: string[], workspace: Listing, caps: CapView[], scope: string, decided: { point: string; reading: string }[] = []): string {
  return [
    "任务：把用户的要求整理成可逐项验收的需求。保留用户的原话；不要替用户决定没说的事。",
    "", `用户原文：${J(raw)}`,
    ...(answers.length ? [`用户后来补充：${J(answers)}`] : []),
    ...(decided.length ? ["用户已经选定的理解（必须照用；assumptions 里同一处的 reading 原样写用户选的这一项）：", ...decided.map((d) => `- 「${d.point}」：${d.reading}`)] : []),
    `任务目录（用户选定，相对路径的根；用户说的「这个目录」「当前目录」「下载」等指的就是它）：${scope}`, "目录现在的内容：", J(workspace),
    "", "系统已注册的能力（只有这些能被执行）：", J(caps.map((c) => ({ id: c.id, description: c.description }))),
    "", CHECKS_DOC,
    "", "要求：", "- requirements 逐条对应原文里的一个要求或约束（含「其他文件不动」「不要覆盖」这类限制）；每条给 quotes：原文里支持它的原话片段。",
    "- 能用代码核验的用 deterministic 并填 name/args；只能看出来对不对的用 semantic；user_confirmation 只用于结果只有用户能判断的要求，不要用它表达「用编辑器做」「不要覆盖」这类过程约束——过程约束放进 constraints。",
    "- 原文缺了只有用户知道的信息（哪个文件、内容、位置），写进 missing，并给一个用户能直接回答的问题；不要用猜的值补。",
    "- 「放到 / 移到 / 归档到 / 整理到」某处，默认是移动（原位置不再有），不要问「移动还是复制」。用户已经回答过的问题不要再问。",
    "- missing 的每条带 kind：information = 只有用户知道的信息（哪个文件、什么内容、放哪）；observable = 打开文件或看目录就能查到的事（例如「哪份是最新的」「文件里写的是哪个项目」），程序不会去问用户，会让计划先读；approval = 你已经知道怎么做、只是想要许可。有后果的动作（删除、覆盖）程序会在执行前自己向用户确认，所以 approval 类一般不需要写；写了也不会变成问题去问用户。",
    "- 用户如果回答「随便」「你看着办」「由你决定」，就是把选择交给你：user_delegated 填 true，按常理做决定、写进需求；程序会在动手前把整个计划给用户过目一次。",
    "- assumptions：原文某一处能有不止一种说得通的理解时，每处写一条：point = 原文里有歧义的那几个字；reading = 你选的理解；alternatives = 其他说得通的理解（做出来结果一样的不算，不要写）；evidence = 能把几种理解区分开的证据，每条必须原样是下面之一：目录里的一个完整路径、某个文件里完整的一行（或连续几行）、用户后来的一条补充；原文里出现过的词不算证据——有歧义的正是原文。另有一个模型会只看这些证据来判断它们支持哪种理解。",
    "  程序据此决定：没有证据能区分 → 先把几种理解做成选项问用户；有证据、但计划里有删不掉改不回的动作 → 动手前把计划给用户确认一次；有证据、动作都能撤回 → 直接做，结果里告诉用户你是怎么理解的。只有一种说得通的理解时不要写。",
    "  例：原文「放『招聘/岗位』，改名『姓名-简历.pdf』」，目录里有「张三-前端.pdf」「李四-后端.pdf」 → { point: \"岗位\", reading: \"每份简历各自的岗位（前端、后端）\", alternatives: [\"一个字面名为「岗位」的文件夹\"], evidence: [\"张三-前端.pdf\"] }。",
    "- authorized_rewrites：用户明确要求改写 / 替换 / 覆盖 / 追加的那些已有文件的路径（例如「把 日志.log 的内容改成…」里的 日志.log）。只有列在这里的文件，程序才会不经确认地丢弃其内容；用户要「新建」的文件不要列（它若已存在属于冲突，要问用户）。",
    "- 目录里已有的文件名和内容也是证据：需求可以引用目录里看到的文件名。",
    "- 如果所需的事超出了已注册能力（例如发邮件、打印、转格式、OCR、上传），feasible 填 needs_capability_we_lack 并说明；不要用现有能力硬凑，也不要把用户的要求改写成现有能力能做的事（「打印」不等于「读出来」，「发给某人」不等于「复制一份」）。",
    "", "输出格式示例（字段名必须一样）：",
    J({ requirements: [
      { id: "r1", statement: "任务目录里有 清单.log", check: { kind: "deterministic", name: "file_exists", args: { path: "清单.log" } }, quotes: ["新建 清单.log"] },
      { id: "r2", statement: "清单.log 的内容是「等评审」", check: { kind: "deterministic", name: "text_equals", args: { path: "清单.log", text: "等评审" } }, quotes: ["内容为「等评审」"] },
    ], constraints: ["不动其他文件"], authorized_rewrites: [], user_delegated: false, assumptions: [], missing: [], feasible: "yes" }),
    "- missing 里尽量给 options，2–6 个，程序会渲染成编号选项加「其他」让用户点选；选择是偏好时可以加一个「由你决定」。options_are 说明选项是哪一类：values = 证据里真有的值（目录里的文件、原文里的词），程序会逐个核对，编出来的会被删掉；proposals = 处理这件事的几种做法（例如重名时「只留一份」「第二份加后缀」），按原样给用户选。",
    "缺信息时的 missing 示例：", J([{ what: "要改名的是哪个文件", question: "要改名的是哪个文件？", kind: "information", options: ["memo-a.txt", "方案-b.txt"] }]),
  ].join("\n");
}

export function planPrompt(goal: Goal, raw: string, answers: string[], workspace: Listing, caps: CapView[], effects: string[], previous: unknown, why: string, notes: string[] = []): string {
  return [
    "任务：给出完成用户要求的计划：一组能力调用节点，带依赖。每个节点只调用一个已注册能力；参数稍后由另一步绑定，这里只说每个节点的目的。",
    "", `用户原文：${J(raw)}`, ...(answers.length ? [`用户后来补充：${J(answers)}`] : []),
    "已整理的需求：", J(goal.requirements), "约束：", J(goal.constraints),
    "目录现在的内容：", J(workspace),
    ...(effects.length ? ["已经发生、不能当作没发生的效果：", J(effects)] : []),
    ...(notes.length ? ["提示（含用户拒绝过的事）：", J(notes)] : []),
    "", "可用能力（含输入字段和含义）：", J(caps),
    ...(previous ? ["", `上一版计划：${J(previous)}`, `要改计划的原因：${why}`] : []),
    "", "要求：", "- 只用列表里的能力 id；要读文件内容才能决定后续时，先放一个只读节点，后面的节点依赖它。",
    "- 一个节点做一件事；需要对多个文件做同一件事就多个节点。", "- 不要加用户没要求的动作；不动无关文件。",
    "- 覆盖每条需求：requirement_ids 写这个节点服务于哪些需求 id。",
    "- 能力不够做不到就 outcome=cannot 并说明；缺用户信息就 outcome=need_user 并给 question。有后果的动作（删除、覆盖）由程序在执行前向用户确认，不要用 need_user 去要确认。",
    "", "输出格式示例（字段名必须一样）：",
    J({ nodes: [
      { id: "n1", capability: "fs.mkdir", depends_on: [], purpose: "新建文件夹 归档", requirement_ids: ["r1"] },
      { id: "n2", capability: "fs.move", depends_on: ["n1"], purpose: "把 a.txt 移进 归档", requirement_ids: ["r2"] },
    ], outcome: "plan" }),
  ].join("\n");
}

const BIND_RULES = `绑定方式（每个参数一个对象，用 kind 字段说明方式，其余字段按方式给）：
- source_span：值是用户原文（或用户补充）里的原话。给 quote（逐字、不改写、不加引号）和 occurrence（第几次出现，从 1 起）。程序会原样切片，所以 quote 必须能在原文里逐字找到。
- resource_ref：值是目录里现有的一个文件或文件夹。给 path（目录列表里的相对路径）。
- upstream_output：值来自前面一个只读节点的输出。给 node_id 和 field（如 text）。
- literal：只有两种情况允许：能力的默认值，或从原文直接推出的路径拼接（例如把「归档」文件夹加上原文件名得到 归档/report.pdf）。给 value 和 authority（说明值怎么得来）。
- derived：值要从目录里某些文件的文件名或内容推算出来（例如按发票里的开票日期得到 财务/发票/2025-06，或按用户的命名规则拼出新文件名）。给 value、from_paths（推算所依据的文件，必须是目录里有的）和 how（怎么算的，引用用户说的规则）。程序会把这些文件的内容交给核对方逐项核对，算错会被拦下。
用户没有说的内容不要编（不要替用户起文件名、写正文）；写进 unresolved，reason=missing_user_intent，并给一个用户能直接回答的 question。
值是不是在原文里出现过两次以上且指不同东西，要用 occurrence 区分；分不清就 unresolved reason=ambiguous。
输出格式示例（字段名必须一样）：
{"bindings": {"parent": {"kind": "literal", "value": ".", "authority": "用户没指定子文件夹，能力说明里任务目录本身填 ."},
              "name": {"kind": "source_span", "quote": "清单.log", "occurrence": 1},
              "text": {"kind": "source_span", "quote": "等评审", "occurrence": 1}},
 "unresolved": []}
推算时：{"bindings": {"path": {"kind": "derived", "value": "财务/发票/2025-06", "from_paths": ["发票_京东_20250603_99元.pdf"], "how": "用户要求按开票年-月建文件夹，月份两位数；该文件名里的日期是 20250603"}}, "unresolved": []}
缺信息时：{"bindings": {"target": {"kind": "resource_ref", "path": "todo.txt"}},
 "unresolved": [{"parameter": "line", "reason": "missing_user_intent", "question": "要加的那一行写什么？"}]}`;

export function bindPrompt(raw: string, answers: string[], node: Omit<PlanNode, "args">, cap: CapView, workspace: Listing, upstream: Record<string, unknown>, scope: string, why: string): string {
  return [
    "任务：为计划里的一个节点绑定能力参数。每个参数说明值从哪里来；程序负责取值和校验。",
    "", `用户原文：${J(raw)}`, ...(answers.length ? [`用户后来补充（按先后）：${J(answers)}`] : []),
    `任务目录（相对路径的根；用户说的「这个目录」「下载」等就是它，不是子文件夹；填 parent 时任务目录本身写 "."）：${scope}`, "目录现在的内容：", J(workspace),
    "", `这个节点：${J(node)}`, "要调用的能力和参数定义：", J(cap),
    ...(Object.keys(upstream).length ? ["前面节点的输出：", J(upstream)] : []),
    "", BIND_RULES,
    ...(why ? ["", `上一次绑定被拒绝，原因：${why}。请改正。`] : []),
  ].join("\n");
}

export function intentPrompt(raw: string, answers: string[], actions: string[], constraints: string[], evidence: Record<string, string>, decided: { point: string; reading: string }[] = []): string {
  return [
    "任务：独立核对。下面是程序即将执行的动作（人话描述，参数已经取好）。请对照用户原文和给出的证据，判断这些动作是不是用户要的。",
    "", `用户原文：${J(raw)}`, ...(answers.length ? [`用户后来补充：${J(answers)}`] : []),
    ...(decided.length ? ["用户已经选定的理解（动作必须照这个理解；不照的判 mismatch）：", ...decided.map((d) => `- 「${d.point}」：${d.reading}`)] : []),
    "约束：", J(constraints),
    ...(Object.keys(evidence).length ? ["动作涉及的文件，现在的内容（证据；参数里的值如果来自文件内容，在这里核对）：", J(evidence)] : []),
    "", "即将执行的动作（按顺序）：", ...actions.map((a, i) => `${i + 1}. ${a}`),
    "", "判断：", "- matches：动作忠实于原文，没有改写、对调、漏掉要求，也没有多做。",
    "- mismatch：有参数弄反、文件弄错、内容改写、违反约束等；说明哪里不对。",
    "- insufficient_information：动作里的某个值是猜的。同时填 ask_user：缺的东西只有用户知道（例如要写什么内容）就填 true，并在 question 里写一个用户能直接回答的短问题；缺的是能从文件里查到的证据就填 false，程序会重新取值，不去打扰用户。",
    "- requires_more_steps：动作对，但只完成了一部分要求。",
  ].join("\n");
}

export interface Option { id: string; text: string }

export function choicePrompt(question: string, context: unknown, options: Option[]): string {
  return ["任务：从下面的选项里选一个。只能选给出的 id。", "", "材料：", J(context), "", `问题：${question}`, "选项：", ...options.map((o) => `- ${o.id}: ${o.text}`)].join("\n");
}

export function verifyPrompt(requirement: unknown, raw: string, evidence: unknown): string {
  return ["任务：根据证据判断一条需求是否满足。证据不足就 unknown，不要猜。", "", `用户原文：${J(raw)}`, `需求：${J(requirement)}`, "证据：", J(evidence)].join("\n");
}
