# 三个接口：工具、事件、控制（版本 1）

执行层拆成独立进程（deskmind#90 第 6 项）之后，app、执行层、运行时之间只通过下面三个接口说话。这份文档写清楚每个接口长什么样、现在是第几版、什么改动要升版本。

用到的词：
- **执行层：** `src/executor`。管运行目录、事件记录、同意凭证的密钥、判官、技能和 hands，负责归属、后果、同意、核对、停止和撤回。
- **运行时：** `src/runtime`。理解要求、计划、调工具的那一层（agent 循环）。拆分之后它是执行层启动的子进程。
- **执行层端口（ExecutorPort）：** `src/protocol/port.ts`。运行时能找执行层做的事情的全部清单，也就是 P2 时 MCP 工具集在 TypeScript 里的样子。P1（现在）运行时和执行层还在同一个进程里，运行时只拿到这个端口，别的都拿不到（`src/host/frontier.ts` 是唯一同时认识两边的地方）。
- **app：** DeskMind Hands.app 里的 Swift 小助手，它启动 harness，读事件，写回答。

版本号都在 `src/protocol/version.ts`：`{tools: 1, events: 1, control: 1}`。

## 一、工具（tools，第 1 版）：运行时 → 执行层

MCP（JSON-RPC 2.0，stdio，每行一条）。服务名 `deskmind-executor`，实现在 `src/cli/mcp.ts`。

- `initialize` 按 MCP 的规矩商量版本：客户端要的是我们会说的（`2025-06-18` 或 `2024-11-05`）就照它回，否则回我们的 `2025-06-18`；同时在 `capabilities.experimental.deskmind` 里给出三个接口的版本：`{"tools":1,"events":1,"control":1}`。接入方据此判断自己认不认识。
- `tools/list` 列出九个工具：begin、snapshot、observe、plan、classify、act、verify、stop、end。名字和输入格式（inputSchema）固定在 `test/fixtures/mcp-tools.golden.json`，测试 `test/protocol.test.ts` 逐字比对；要改工具集，先想清楚是加还是改（见第四节），再用 `UPDATE_GOLDEN=1 npx vitest run test/protocol.test.ts` 重写这个文件，和改动一起提交。
- `stop` 一到就处理，不排在前面的请求后面。

**P1 起的执行层端口**（`ExecutorPort`，进程内调用；P2 把运行时挪进子进程后，按同样的名字和参数作为 MCP 工具提供，属于「加工具」，不升版本）：

| 方法 | 做什么 | 执行层在里面管的事 |
|---|---|---|
| `begin` | 开始任务，返回整台电脑、任务目录、可能适用的教程、文件工具清单 | 锁屏、读不到电脑时直接结束（environment） |
| `snapshot` / `observe` | 只读地看 | |
| `act` | 做一个界面动作 | 定后果类别、意图核对；要同意时自己出卡、等用户回答、签名、再做（act-and-wait）；签名的钥匙只在执行层这边 |
| `file` | 做一个文件动作 | 同上，外加需要模型改写的内容（transform）在这里生成 |
| `plan` | 交计划 | 开始闸门（依据不够的理解出歧义卡）和计划卡；同意后按对象、按网站签凭证 |
| `askUser` / `answer` | 问用户、给答案 | 用户的回答记成「用户的话」，之后每个判官都看得到，不管运行时转述没有 |
| `readSkill` | 读一份教程 | 读过的教程判官也看 |
| `finish` | 说任务结束了 | done 只是声明：独立核对通过才算 succeeded |
| `steers` | 取用户中途说的话（两步之间） | 见第三节 steer |
| `end` | 收尾，拿结果 | 结果卡、撤回 |

运行时不再持有签名的一方，也传不进同意凭证：`act` 没有这个参数。

调用的规矩：
- **顺序：** 先 `begin`，整个任务只能调一次（再调会报错）。之后随便调其他方法。任务结束以后只调 `end`。
- **回复：** 除了 `begin`、`snapshot`、`observe`、`steers`、`end`，每个方法回 `{text, isError?, done?}`。`text` 是给模型看的话。`isError` 表示这一步没做成或被拒了（原因在 `text` 里），任务还在继续。`done` 表示任务的状态已经定了（核对通过、用户取消、停止、预算或拒绝次数用完等）：之后的 `act`、`file`、`plan`、`askUser`、`answer`、`finish` 一律不做，回 `{isError: true, done: true}`，调用方只该再调 `end`。
- **文件动作只走 `file`：** `act` 收到 `kind: "file"` 直接拒绝，因为有的文件能力需要执行层自己先生成内容（改写），调用方不能代劳。
- **界面变了（stale）：** 动作基于的观察已经过期时，这一步不做；执行层会顺手重新看一次那个窗口，把新的观察放进回复的 `after`，调用方按它重新决定，不要照旧重试。
- **只能找证据：** 核对的结论是「事做完了，只缺证据」时，之后 `act` 只放行 `wait` 和只读的文件动作，`file` 只放行只读能力；其余都拒绝，直到调用方用 `finish unconfirmed` 结束，或者用户改了要求。
- **中断后对不上（加的，不升版本）：** 重新开始时，日志里有一步只有意图、没有回执，查不出它生效没有（finding 是 unknown），而它要改的文件在那之后被改过：执行层拒绝再写这个文件（`act` / `file` 回 `refused`，结果里带可选字段 `reconcile`，是卡片用的事实），直到用户在对账卡上答了。服务在 `begin` 里就出这张卡。它是一张要用户同意的卡（`kind: "action"`，现在的 app 显示成「同意 / 不同意」：同意回 `approve` 选项，不同意回 `cancel` 选项），选项 `approve`「在现在的内容上继续」、`cancel`「先停下，我来看看」，没有自由输入；卡上的话写明同意和不同意各是什么意思。没答到的（被改要求作废）在写到这个文件时再出。这件事在日志里记成 `reconcile_pending`，直到用户答了「继续」（`reconciled`）：进程在卡开着时退出、或者用户选了先停下之后用同一个 run_id 再开，都会再问一次。选「先停下」或没有回答：任务以 `cancelled` 结束，reason 就是 `needs_reconciliation`，什么都没写，app 据此显示「需要你看一下」。选「继续」：用户的回答记成用户的话（每个判官都看得到），`begin` 返回的 `recovered` 带 `reconciled: "continue"`，核对时证据里有中断恢复记录和用户的决定。
- **改要求之后：** 一次调用的回复里带了用户新说的话之后，调用方在听到这些话之前决定的其余步骤都会被拒绝（「在那之前决定的，没有做」），直到它再调一次 `steers`。我们的循环在每一轮开始前调；别的调用方也要在自己的每一轮开始前调。`answer` 也算一步：改要求之前决定的答案不会给出去，也不会留在结果里。带着新话的回复有 `steers` 字段（原话全文）：调用方要把它当作用户的话保留下来（我们的循环把它作为一条用户消息再交给模型，上下文压缩不会截短用户消息；工具结果会被截短）。app-run 在任务那一行之后、同一批读到的 steer 行不会丢：先存着，执行层接上之后再交过去。

同意凭证和挑战的格式（`Challenge`、`ConsentToken`、后果类别和它们的顺序、`canon` / `digestOf`、网址算作哪个站点的 `siteOf`、签同意的一方 `ConsentProvider`）属于这个接口，放在 `src/protocol/consent.ts`；`src/executor/types.ts` 和 `consent.ts` 原样转出，旧的 import 不用改。

## 二、事件（events，第 1 版）：执行层 → app

每行一个 JSON 写到 stdout，先写进运行目录的 `events.jsonl`（带 `seq`，落盘再发），断线重连时 app 说出最后收到的 `seq`，补发之后的。格式在 `src/protocol/events.ts`。

- `start` 带 `protocol: {"events": 1}`。旧版本的运行记录里没有这个字段，读的时候当作第 1 版。
- 种类：start、preparing、plan、step、ask、waiting、resumed、consent、refused、answer_given、task_done、result_response。app 不认识的种类直接忽略。
- 中断后对不上的卡（见第一节）用已有的 `action` 种类，选项种类是 `approve` / `cancel`。`task_done` 的 status 是 `cancelled`、reason 是 `needs_reconciliation` 时，意思是任务停在等用户查看这个文件。
- `resumed` 可以带 `voided: "steer"`（P1 加的可选字段）：这张卡没等到回答就作废了，因为用户中途改了要求。app 收到就把卡关掉；之后再发来这张卡的回答，会被记成一条 `refused`，不算数。**一旦有卡作废过，这次运行剩下的时间里，不带 `ask_id` 的回答一律被拒绝（`refused`），因为分不清它是不是给作废那张卡的迟到回答。所以 app 回答卡片时应当总是带上 `ask_id`。**
- 用户在任务已经结束之后（核对通过、停止、或者运行结束后等结果卡的那段时间）才发来 `steer`：执行层不采用，发一条 `refused`（`what` 是 `steer: <原话>`，`why` 是 "the task already finished"）。这是 `task_done` 之后唯一可能出现的 `refused`。
- 每次运行只有一个 `task_done`，而且是最后一个运行中的事件（之后只可能有对结果卡的 `result_response`）。
- **步骤（M0 加的，不升版本）：** 每个 `act` / `file` 调用是一步，由执行层发（不再由运行时的工具调用发，所以换了运行时也一样）。`step` 多了可选字段：`step_id`（这一步的 id，`step_result` 和 trace 用它对上）、`human`（按请求语言写的一句话：动作、元素的名字和角色、在哪个窗口；不出现元素 id 和 JSON）、`target`（`{id, label, role}`，动作作用的元素，取自调用方上一次看这个窗口的结果）、`plan_step`（调用方说这一步属于计划第几步，从 1 数；只用来显示，不影响同意和核对）。`text` 照旧是动作的 JSON（文件动作是能力名和参数），给现在的 app 用。新种类 `step_result`：`{step_id, status, why?, executor_status?, consequence?}`，status 是 `ok`、`unverified`（做了，没读回来）、`refused`（执行层或用户没让做：用户不同意、要先交计划、只能找证据、停止、锁屏等，执行层自己的状态在 `executor_status`）、`stale`（调用方看过之后界面变了，没做）、`error`。每个 `step` 后面都有一个同 id 的 `step_result`，在下一个 `step` 之前。被改要求拦下的、参数不全的调用不算一步，不发 `step`。执行层的拒绝照旧另发一条 `refused`。和以前不同的两处：做了没读回来不再另发一条带 `status: "unverified"` 的 `step`，由 `step_result` 说；文件动作的 `step` 在动手前发，不再带 `status`，`consequence` 是执行层按结构定的类别（以前是做完后带结果发的）。**现在的 app 受影响：**它只看 `step`、不看 `step_result`，没有 `status` 就当成功，所以文件动作一律显示成绿色的成功行；没做成的文件动作另有一行 `refused`（执行层的拒绝照旧发），但那条绿色行不会变。新界面要按 `step_result` 定一步的结局。**`step_result` 可能缺：**停止时如果有一个动作还在驱动那里没回音，`task_done` 会先写（见第三节「信号」），那一步就没有 `step_result`；`task_done` 之后的事件只进 trace。所以 app 收到 `task_done` 时，要把还没有结局的步骤一并关掉：`task_done` 的 reason 是 "a step was in progress; its result is unknown" 时，那一步写「不确定做没做成」（它的对象在 `changes.unconfirmed` 里），其余按任务的结局显示成「已停下」。`human` 和 `target` 只取调用方做决定时看的那一眼（epoch 对得上），对不上就不带 `target`、元素说成「一个元素」，免得说错是哪个元素。
- **卡片的字段（M0 加的，不升版本）：** `ask.card` 照旧有拼好的 `text`，另外可以带：`plan`（计划卡）：`{steps: [{purpose, class, objects: [{ref, label, owner, marks}], sites: [{host, sends, asks_each}]}], foreground: {apps, note} | null}`。`class` 是执行层定下的后果类别；`objects` 只列卡上写了的对象（解析得到的窗口、标签页、任务目录里的文件），`owner` 是 `user` / `task`，`marks` 是这一步对它做什么：`changes`（改你的东西）、`sends`（从它往外发）、`opens_pages`（在你的这个窗口里打开网页）；`sites` 是这一步打开的每个网站、计划里说发过去的内容（没说是 null）、以及到时候是否还会逐次问（`asks_each`：任务读过材料，打开算往外发）；`foreground` 是只能在前台操作的应用和卡上那句话。`consent`（单步授权卡，`kind: "action"`）：`{action, action_text, target, object, object_label, consequence, outgoing: [{kind, label, value}], site}`；`action` 是动作种类，`action_text` 是不带后果说明的一句话，`target` 是元素名字，`outgoing` 是要发出去的东西逐项列出（`field` 填了的字段、`selected` 选中的一项、`typed` 这次任务打的字、`text` 窗口里的其他文字），`site` 是逐站询问时问的网站。两者都只是 `text` 的拆分，不多说也不少说。
- **成本和判官（M0 加的，不升版本）：** `model_call`：`{call_id, role, model, outcome, tokens_in, tokens_out, cost_usd, latency_ms, step_id?, judge_id?}`，每次模型调用一条：动手的模型每一轮（role `loop`）、判官每一档的每次提问、改写（`transform`）。花费是美元：服务没给就按价目表算，不在表里的是 0。`tokens_in` 是模型读的全部输入，包括从服务的提示缓存里读的那部分；那部分另记在 `cache_read`（动手模型和判官同一个算法）。缓存部分按缓存价算，价目表里没有缓存价就按输入价算，并带 `cost_estimated: true`。`judge`：`{judge_id, question, answer, by, confidence?, tiers: [{tier, outcome, choice, confidence?, settled}], shadow?: {tier, top, agree}, step_id?, ms?}`，每个判官问题一条（缓存命中的不算新问题，不发）；`question` 是问题的种类（`intent` / `outgoing` / `provenance` / `verify` / `evidence` / `other`）；`answer` 是 null 表示哪一档都没能定下来（执行层按保守的一边走）；`tiers` 是问过的每一档和它说了什么、是否由它定下；`shadow` 是抽样让顶档再答一次的比对。这一问的模型调用带同一个 `judge_id`，在步骤里问的带 `step_id`。`task_done` 多了可选的 `usage`：`{calls, tokens_in, tokens_out, cost_usd, by_role}`，这次运行全部模型调用的合计。`task_done` 之后不再发 `model_call`（比赛里晚到的判官回答只记在 `model_calls.jsonl` 和 trace 里）。
- **调用链（M0 加的，旁路文件，不是事件）：** 运行目录里的 `trace.otel.jsonl` 是这次运行的 OpenTelemetry 调用链，按 GenAI 语义约定：`invoke_agent deskmind`（整次运行）→ `deskmind.turn`（模型的一轮）→ `chat <模型>`（动手模型的调用，`gen_ai.*`：模型、输入输出 token）和 `execute_tool <工具>` → `deskmind.step`（一步，带 `deskmind.step_id`）→ `deskmind.classify`、`deskmind.judge <问题>`（带 `deskmind.judge_id`、定下来的档位 `deskmind.tier`、影子比对）→ 判官每档的 `chat <模型>`；`deskmind.ask_user`（等用户答卡）、`deskmind.user_busy`（等用户停手）、`deskmind.perform`（驱动去做，`deskmind.token_kind` 是用到的同意凭证种类：action / object / site / rule / none）；`deskmind.plan`、`deskmind.verify`。每个 span 有父 span、开始结束时间、状态；花费在 `deskmind.cost_usd`（也写 `gen_ai.usage.cost`）。每行是一个 OTLP/JSON 的 ExportTraceServiceRequest，装着刚结束的那个 span（OpenTelemetry collector 的 file exporter 格式）；运行结束时还开着的 span 以错误状态补上结束。`harness.mjs trace export --run <id> --out <文件> [--runs <目录>]` 把一次运行合成一个请求，可以直接 POST 给 Jaeger、Phoenix、Langfuse 的 `/v1/traces`。只写本机，不往外发。`trace.jsonl` 的每一行多了 `span_id`（写这一行时所在的 span）和 `step_id`（在步骤里写的）。
- **光标和每步截图（M0 加的，不升版本；要 hands 的配套改动）：** `step.target` 多了 `rect_norm`（元素在它窗口里的位置，`[x, y, w, h]`，都是 0–1 的比例，给画面上的光标用；app 不用知道窗口在屏幕哪里）和 `frame`（同一个元素在屏幕上的位置，点，左上角为原点），取自调用方上一次观察（hands 的 observe 给窗口的 `frame`、元素的 `rect`）；驱动没给就没有。`step_result` 多了 `shot`（这一步做完后目标窗口的小图，PNG，最长边不超过 1024 像素、不超过 200 KB，路径相对运行目录：`shots/<step_id>.png`；只有改东西的步骤才拍，看一眼、等待、没做成的步骤没有）、`target_frame` 和 `window_frame`（`{x, y, w, h}`，动手前元素和窗口在屏幕上的位置，来自 hands 的回执）。这些只给 app，模型看不到（观察结果里窗口的 `frame` 也不给模型）。关窗口的步骤不拍。图只存在本机的运行目录里。

## 三、控制（control，第 1 版）：app → 执行层

app 往 `app-run` 的 stdin 写，每行一个 JSON。第一行是任务本身（`{raw, config, …}`，或用 `--request <file>` 给），之后是控制行，按 `type` 分四种（`src/protocol/control.ts`）：

| type | 内容 | 什么时候 |
|---|---|---|
| `answer` | `{"type":"answer","ask_id":"ask_…","option":n}` 或 `…,"text":"…"}` | 回答一张卡（`ask` 事件）；`ask_id` 不是当前这张卡的，记一条 `refused`，不算回答 |
| `stop` | `{"type":"stop"}` | 随时：立刻停下，等着回答的卡按「没回答」处理，任务以 stopped 结束 |
| `respond` | `{"type":"respond","option":n}` | 运行结束后、`--linger` 秒内，回答结果卡（比如撤回） |
| `steer` | `{"type":"steer","text":"…"}` | 运行中用户改了要求（P1 起交给执行层）。正在做的那一步照旧做完，新要求在两步之间才生效；运行时在新要求生效前已经决定的下一步不做，回给它的是新要求。判官看得到原来的要求和之后每一次改动。开着的卡片立即作废（`resumed` 带 `voided`），那一步按新要求重新决定，要的话再问一次。新要求一生效，之前计划签的凭证（对象、网站，以及计划卡上写的发过去的内容）全部作废：用户可能刚说了「别动这个窗口了」。之后要用户同意的步骤，先交新计划、出新的计划卡；用户在单独的卡上同意过的网站（逐次批准的）照旧有效 |

第 1 版仍然认识加 `type` 之前的写法，Swift 小助手可以以后再改：`{"stop":true}` 是 stop，`{"respond":n}` 是 respond，其他没有 `type` 的对象（`{ask_id, option}`、`{ask_id, text}`、`{text}`）是 answer。带着不认识的 `type` 的行直接忽略。

**信号：** `app-run` 收到 SIGINT 或 SIGTERM，走的是和 stop 行同一个只生效一次的停止：整次运行只有一条 `refused`（by user），reason 用最先要求停的那一方的（stop 行是 "stopped by the app"，信号是 "stopped by SIGTERM" 这类）。之后写 `task_done`（status `stopped`），退出码 0。
- 运行时自己结束得快（通常几十毫秒），就按它的结果写，写完马上退出。
- 0.8 秒时还没结束：如果有一个改东西的动作已经交给驱动、还没回音（hands 一个动作最长可以等 120 秒，它可能在「停下」之后才生效），就再等它的回执，最多 10 秒。等到了，照常结束；等不到，`task_done` 的 reason 写 "a step was in progress; its result is unknown"，并把这个动作的对象列进 `changes.unconfirmed`，不说成干净地停了。没有这样的动作，就直接写 `task_done` 退出。
- 第二个信号：不再等。`task_done` 还没写的就写上（规则同上），然后立刻退出，不等 stdout 写完。
- 还没读到任务就收到信号：直接退出。

## 四、兼容规则

- **加东西不升版本：** 新的事件种类、新的可选字段、新的工具、新的控制类型。读的一方必须忽略自己不认识的种类、字段和类型。
- **删、改名、改含义要升主版本：** 去掉一个工具或事件种类，改字段名，改一个字段或工具的意思（比如后果类别的顺序、一个状态值代表什么），必填字段换了格式。
- **旧版本再支持一个周期：** 升版本之后，上一版在下一个发布周期里照样能用（和控制第 1 版接受不带 `type` 的行一样），之后才去掉。
- 三个接口各自计版本，互不牵连。MCP 本身的版本（`2025-06-18`）跟着 MCP 规范走，和这里的版本无关。
