# 接口：工具（第 2 版）、事件（第 1 版）、控制（第 1 版）、会话（第 1 版）

执行层拆成独立进程（deskmind#90 第 6 项）之后，app、执行层、运行时之间只通过下面三个接口说话。这份文档写清楚每个接口长什么样、现在是第几版、什么改动要升版本。聊天用的会话进程是另一条通道，见最后一节「会话（第 1 版）」。

用到的词：
- **执行层：** `src/executor`。管运行目录、事件记录、同意凭证的密钥、判官、技能和 hands，负责归属、后果、同意、核对、停止和撤回。
- **运行时：** `src/runtime`。理解要求、计划、调工具的那一层（agent 循环）。P2 起它是执行层启动的子进程（`harness.mjs runtime`），见下面「两个进程」。
- **执行层端口（ExecutorPort）：** `src/protocol/port.ts`。运行时能找执行层做的事情的全部清单。每个方法的输入格式在 `src/protocol/tools.ts`，运行时给模型的工具参数和 MCP 的 `tools/list` 用的是同一份。P2 起运行时通过 MCP 调它（`src/transport/mcp-port.ts`）；`DESKMIND_EXECUTOR_INPROC=1` 时运行时和执行层在同一个进程里直接调（P1 的样子）。`src/host/frontier.ts` 是唯一同时认识两边的地方。
- **app：** DeskMind Hands.app 里的 Swift 小助手，它启动 harness，读事件，写回答。

版本号都在 `src/protocol/version.ts`：`{tools: 2, events: 1, control: 1, session: 1}`。执行层的 MCP `initialize` 仍然只报前三个。

## 两个进程（P2，10-21）

app 的 Swift 小助手启动的是执行层：`harness.mjs executor`（老名字 `app-run` 照样能用，参数、stdin、stdout 都不变）。执行层再启动运行时 `harness.mjs runtime` 作为自己的子进程，用子进程的 stdin / stdout 说 MCP：执行层是服务方，运行时是调用方。

| | 执行层（executor） | 运行时（runtime） |
|---|---|---|
| 管的东西 | 运行目录、`events.jsonl`、日志 `journal.jsonl`、签名的钥匙、判官和它们的网关、教程、卡片、驱动（hands 子进程） | agent 循环和它的模型 |
| 写的文件 | `trace.jsonl`（执行层的记录，trace 查看的来源）、`model_calls.jsonl`（这次运行的每一次模型调用，`role` 分开：`loop` 是动手的模型，其余是判官和改写）、`trace.otel.jsonl`（调用链） | `runtime.jsonl`（循环自己的事件：每一轮模型调用 `model.call`、每次 MCP 调用的往返时间 `mcp.rtt`）、`runtime.log`（它的 stderr） |
| 启动参数 | 和以前一样 | 没有。用户的话、模型、预算、日志路径在 `initialize` 回复的 `_meta`（`"deskmind/agent"`）里经管道交过去：不放命令行和环境变量（同一用户的进程用 `ps eww` 看得到环境变量，而且命令行加环境变量一共只有约 1 MB，长的粘贴会超） |
| 环境变量 | 和以前一样 | 白名单：PATH、HOME、TMPDIR、LANG / LC_*、TZ、Node 自己的设置、代理，加上它的模型所在那一家服务的 key 和 URL。DeskMind 自己的东西（Brain 的 token、别家服务的 key、hands 的路径、同一进程的开关）一概不给 |

- **app 看到的事件不变。** 界面上的「一步」（`step`）以前由循环的 `tool.call` 事件生成，现在由执行层收到的调用生成（`src/host/port-trace.ts`）：两种运行方式下 app 收到的事件流一样。有一处细微差别：`step` 的文字来自按格式检查、转换之后的参数（模型写成字符串的 `"dy":"3"` 显示为 `3`，值为 null 的可选字段不显示），P1 用的是检查之前模型的原文。`trace.jsonl` 里每次端口调用有 `tool.call` / `tool.result`（带执行层用的时间 `ms`），子进程方式下还有每次 MCP 调用的 `mcp.call`（`queued_ms` 排队、`ms` 处理）和 `agent.start` / `agent.exit`。
- **停止：** app 的 stop 照旧先到执行层（执行层拒绝之后的一切动作，开着的卡不再等），再用通知 `notifications/deskmind/stop` 告诉运行时别再调模型。正在做的那一步照旧等它的回执：运行时最后调的 `end` 排在它后面处理。
- **运行时死了：** 运行时在调 `end` 之前退出（崩溃、被 kill -9）或管道断了，执行层把任务记为 `failed`，reason 是 `agent exited (<信号或退出码>)`：先让正在处理的调用做完（交给驱动的动作拿到回执），开着的卡不再等，然后照常收尾——`task_done`（带 changes）、结果卡、撤回都和平常一样。
- **执行层死了：** 运行时的 stdin 一断就退出（退出码 3），hands 也是 stdin 断了就退出：kill -9 执行层不会留下孤儿进程。终端里的 ^C 会发到整个进程组，运行时忽略 SIGINT，等执行层的 stop 通知。
- **运行时报给执行层的（M0 的记录跨进程）：** 运行记录归执行层：`model_calls.jsonl`、`model_call` 事件和 `task_done.usage`、调用链 `trace.otel.jsonl`。进程内时运行时靠同一进程里的上下文把自己那一份交过来；分进程后改成在同一条管道上报（`src/transport/report.ts`）：每一轮模型调用一条通知 `notifications/deskmind/model_call`（role `loop` 的记录原样）；运行时的 span（一轮 `deskmind.turn`、模型调用 `chat <model>`、一次工具调用 `execute_tool <name>`）开始和结束各一条 `notifications/deskmind/span`，执行层在这次运行的 tracer 上开同样的 span（用自己的 id，对应关系自己记）；`tools/call` 的 `_meta` 里带 `"deskmind/span"`（运行时正在进行的 execute_tool span），执行层这次调用里开的 span（step、classify、judge、perform）就挂在它下面。通知和请求走同一条有序管道，所以 span 的开始总在引用它的调用之前到。运行时死了没结束的 span，执行层收尾时照常补上结束（标成错误）。`act` 的 `plan_step` 是 `tools.ts` 里 `act` 输入格式的一个可选字段，原样过 MCP。
- **执行层不全信运行时报来的东西：** 模型调用的记录一律当作 role `loop`，不带 step_id / judge_id，数字限成有限的非负数并封顶，字符串截短；span 只认 `deskmind.turn`、`chat <模型>`、`execute_tool <工具>` 三种名字，属性最多 8 KB，时间限在这次运行之内，同一个 id 只认一次，最多 2 万个；`_meta` 里的计数只认像样的名字、有限的非负数，而且只增不减；执行层读运行时的一行超过 16 MB 算违反协议：等着的请求一律失败、连接关掉，任务以 `failed`、reason `agent exited (protocol: line too long)` 结束，绝不悄悄丢掉（等那一行的一方会一直挂着）；运行时读执行层（可信的方向）不设上限；单独起的服务（`pnpm mcp`）收到超过 16 MB 的请求，能从行首读出 id 就回一个 JSON-RPC 错误（-32600），读不出就关连接。执行层发出去的回复也有上限（4 MB）：一个巨大窗口的观察会截掉元素和文字，带 `truncated` 标记说明截了多少。通知每秒超过 500 条（突发 2000）丢掉并按方法计数，记在 trace 的 `agent.dropped`；丢掉的里面有模型调用的上报时，`task_done` 带 `usage_incomplete: true`，说明 usage 偏低。运行时 stdout 上不是 JSON-RPC 的行写进 `runtime.log`。运行时不能调 `stop`（停止是用户的，经 app 的控制行来）：它用 `finish` / `end` 结束，或者退出。
- **没有隔离：** 运行时和执行层是同一个用户的两个进程，没有操作系统级的沙箱。上面这些只保证它碰不到签名的钥匙、卡片和执行层的判断，也伪造不了执行层的记录；它自己读得到这个用户能读的文件。给外来的运行时（Codex 之类）一个真正的沙箱是以后的事。
- **退回同一进程：** 环境变量 `DESKMIND_EXECUTOR_INPROC=1`（小助手从 models.env 填进环境）时循环在执行层进程里跑，不用重新打包；文件和事件一样（没有 `mcp.call` / `agent.*`）。
- **评测：** `pnpm eval -- --engine runtime` 也按子进程跑（每题一个），同样认 `DESKMIND_EXECUTOR_INPROC=1`；结果行里有 `runtime_mode`。

## 一、工具（tools，第 2 版）：运行时 → 执行层

MCP（JSON-RPC 2.0，stdio，每行一条）。服务名 `deskmind-executor`，实现在 `src/cli/mcp.ts`。我们自己的运行时是执行层的子进程；外来的调用方（Codex 之类）用 `pnpm mcp -- --driver sim|hands [--consent auto|none]` 单独起一个服务，`begin {raw}` 开始任务。单独起的服务没有 app：`--consent none`（默认）时没有人回答卡片，要用户同意的步骤不做、任务结束；`--consent auto` 时有「同意」选项的卡一律同意并记日志，只用于开发。

- `initialize` 按 MCP 的规矩商量版本：客户端要的是我们会说的（`2025-06-18` 或 `2024-11-05`）就照它回，否则回我们的 `2025-06-18`；同时在 `capabilities.experimental.deskmind` 里给出三个接口的版本：`{"tools":2,"events":1,"control":1}`。接入方据此判断自己认不认识。客户端在自己的 `capabilities.experimental.deskmind.steer` 写 `"push"`，表示要执行层推送「有新的要求在等」（见下面「改要求」）。
- `tools/list` 列出端口的方法（名字是方法名的 snake_case）：begin、snapshot、observe、classify、act、file、plan、ask_user、answer、read_skill、finish、steers、end，外加单独起的服务上调用方自己的停止开关 stop（执行层自己的运行时调 stop 会被拒绝）。名字和输入格式（inputSchema）固定在 `test/fixtures/mcp-tools.golden.json`，测试 `test/protocol.test.ts` 逐字比对；要改工具集，先想清楚是加还是改（见第四节），再用 `UPDATE_GOLDEN=1 npx vitest run test/protocol.test.ts` 重写这个文件，和改动一起提交。输入先按格式检查，不对的直接回错误（`isError`），不进执行层。
- 请求按到达的顺序一个一个处理；`stop` 和 `ping` 一到就处理，不排在前面的请求后面。
- 回复：`content` 是给模型看的文字，`structuredContent` 是端口返回的对象原样（`{text, isError?, done?, steers?}` 或 begin / snapshot / observe / classify / end 的对象；`steers` 回 `{steers: [...]}`），`isError` 同端口。
- 调用的 `_meta` 里可以带 `"deskmind/counters"`：我们的运行时每次调用都带上自己的计数（模型调用、token、轮数），执行层据此算整次运行的计数，不用另外问。

**第 2 版和第 1 版的区别（P2，10-21）：** 第 1 版（P0 时的九个工具）直接对着 Executor：`act` 遇到要同意的动作回 `needs_consent` 和挑战，调用方带着 app 签的凭证再来；`verify` 单独要一次核对。第 2 版对着端口：`act` 自己出卡、等用户、签名（act-and-wait），没有 `consent` 参数；`verify` 没有了，核对在 `finish` 里；加了 file、ask_user、answer、read_skill、finish、steers；`classify` 保留（只读，同一个动作同一个 epoch 只算一次，`act` 自己再算时拿到的是同一个结论）。`act` 的含义变了、`verify` 去掉了，按第四节要升版本。第 1 版只在 P0 和 P1 之间存在过，没有任何发布出去的调用方用过，所以没有再支持一个周期。

**执行层端口**（`ExecutorPort`；MCP 工具就是它）：

| 方法 | 做什么 | 执行层在里面管的事 |
|---|---|---|
| `begin` | 开始任务，返回整台电脑、任务目录、可能适用的教程、文件工具清单 | 锁屏、读不到电脑时直接结束（environment） |
| `snapshot` / `observe` | 只读地看 | |
| `classify` | 只读：一个动作会被算成哪一类后果、碰哪个对象、要不要同意 | 和 `act` 用同一个结论 |
| `act` | 做一个界面动作 | 定后果类别、意图核对；要同意时自己出卡、等用户回答、签名、再做（act-and-wait）；签名的钥匙只在执行层这边 |
| `file` | 做一个文件动作 | 同上，外加需要模型改写的内容（transform）在这里生成 |
| `plan` | 交计划 | 开始闸门（依据不够的理解出歧义卡）和计划卡；同意后按对象、按网站签凭证 |
| `askUser` / `answer` | 问用户、给答案 | 用户的回答记成「用户的话」，之后每个判官都看得到，不管运行时转述没有 |
| `readSkill` | 读一份教程 | 读过的教程判官也看 |
| `finish` | 说任务结束了 | done 只是声明：独立核对通过才算 succeeded |
| `steers` | 取用户中途说的话（两步之间） | 见下面「改要求」和第三节 steer |
| `end` | 收尾，拿结果 | 结果卡、撤回 |

运行时不再持有签名的一方，也传不进同意凭证：`act` 没有这个参数。

调用的规矩：
- **顺序：** 先 `begin`，整个任务只能调一次（再调会报错）。之后随便调其他方法。任务结束以后只调 `end`。
- **回复：** 除了 `begin`、`snapshot`、`observe`、`classify`、`steers`、`end`，每个方法回 `{text, isError?, done?}`。`text` 是给模型看的话。`isError` 表示这一步没做成或被拒了（原因在 `text` 里），任务还在继续。`done` 表示任务的状态已经定了（核对通过、用户取消、停止、预算或拒绝次数用完等）：之后的 `act`、`file`、`plan`、`askUser`、`answer`、`finish` 一律不做，回 `{isError: true, done: true}`，调用方只该再调 `end`。
- **文件动作只走 `file`：** `act` 收到 `kind: "file"` 直接拒绝，因为有的文件能力需要执行层自己先生成内容（改写），调用方不能代劳。
- **界面变了（stale）：** 动作基于的观察已经过期时，这一步不做；执行层会顺手重新看一次那个窗口，把新的观察放进回复的 `after`，调用方按它重新决定，不要照旧重试。
- **只能找证据：** 核对的结论是「事做完了，只缺证据」时，之后 `act` 只放行 `wait` 和只读的文件动作，`file` 只放行只读能力；其余都拒绝，直到调用方用 `finish unconfirmed` 结束，或者用户改了要求。
- **中断后对不上（加的，不升版本）：** 重新开始时，日志里有一步只有意图、没有回执，查不出它生效没有（finding 是 unknown），而它要改的文件在那之后被改过：执行层拒绝再写这个文件（`act` / `file` 回 `refused`，结果里带可选字段 `reconcile`，是卡片用的事实），直到用户在对账卡上答了。服务在 `begin` 里就出这张卡。它是一张要用户同意的卡（`kind: "action"`，现在的 app 显示成「同意 / 不同意」：同意回 `approve` 选项，不同意回 `cancel` 选项），选项 `approve`「在现在的内容上继续」、`cancel`「先停下，我来看看」，没有自由输入；卡上的话写明同意和不同意各是什么意思。没答到的（被改要求作废）在写到这个文件时再出。这件事在日志里记成 `reconcile_pending`，直到用户答了「继续」（`reconciled`）：进程在卡开着时退出、或者用户选了先停下之后用同一个 run_id 再开，都会再问一次。选「先停下」或没有回答：任务以 `cancelled` 结束，reason 就是 `needs_reconciliation`，什么都没写，app 据此显示「需要你看一下」。选「继续」：用户的回答记成用户的话（每个判官都看得到），`begin` 返回的 `recovered` 带 `reconciled: "continue"`，核对时证据里有中断恢复记录和用户的决定。
- **改要求之后：** 一次调用的回复里带了用户新说的话之后，调用方在听到这些话之前决定的其余步骤都会被拒绝（「在那之前决定的，没有做」），直到它再调一次 `steers`。新话怎么到调用方（P2 定的）：
  - **我们自己的运行时（推）：** 它在 `initialize` 里要了推送。app 的 steer 一到，执行层把话存下（两步之间才生效，规则不变），同时给子进程发通知 `notifications/deskmind/steer`（不带原话）。运行时只在两种情况下、在下一轮开始前调 `steers`：收到过这个通知，或者上一个回复带了 `steers` 字段；其余的轮不调，省一次往返。原话只走 `steers` 的回复和带新话的回复这两条路，生效在执行层这一侧，和进程内一样。
  - **外来的调用方（取）：** 没要推送的调用方在自己的每一轮开始前调 `steers`。不调也不会让新话悄悄失效：下一次 `act` / `file` / `plan` / `ask_user` / `answer` / `finish` 照样不做、回复里带着新话；只是只读的 `snapshot` / `observe` 不检查新话，一个只看不动的调用方在调 `steers` 或动手之前听不到。`answer` 也算一步：改要求之前决定的答案不会给出去，也不会留在结果里。带着新话的回复有 `steers` 字段（原话全文）：调用方要把它当作用户的话保留下来（我们的循环把它作为一条用户消息再交给模型，上下文压缩不会截短用户消息；工具结果会被截短）。app-run 在任务那一行之后、同一批读到的 steer 行不会丢：先存着，执行层接上之后再交过去。

同意凭证和挑战的格式（`Challenge`、`ConsentToken`、后果类别和它们的顺序、`canon` / `digestOf`、网址算作哪个站点的 `siteOf`、签同意的一方 `ConsentProvider`）属于这个接口，放在 `src/protocol/consent.ts`；`src/executor/types.ts` 和 `consent.ts` 原样转出，旧的 import 不用改。

## 二、事件（events，第 1 版）：执行层 → app

每行一个 JSON 写到 stdout，先写进运行目录的 `events.jsonl`（带 `seq`，落盘再发），断线重连时 app 说出最后收到的 `seq`，补发之后的。格式在 `src/protocol/events.ts`。

- `start` 带 `protocol: {"events": 1}`。旧版本的运行记录里没有这个字段，读的时候当作第 1 版。
- 种类：start、preparing、plan、step、step_result、ask、ask_void、waiting、resumed、consent、refused、steered、verify、changes、model_call、judge、shot_ready、answer_given、task_done、result_response。app 不认识的种类直接忽略。
- 中断后对不上的卡（见第一节）用已有的 `action` 种类，选项种类是 `approve` / `cancel`。`task_done` 的 status 是 `cancelled`、reason 是 `needs_reconciliation` 时，意思是任务停在等用户查看这个文件。
- `resumed` 可以带 `voided: "steer"`（P1 加的可选字段）：这张卡没等到回答就作废了，因为用户中途改了要求。app 收到就把卡关掉；之后再发来这张卡的回答，会被记成一条 `refused`，不算数。**一旦有卡作废过，这次运行剩下的时间里，不带 `ask_id` 的回答一律被拒绝（`refused`），因为分不清它是不是给作废那张卡的迟到回答。所以 app 回答卡片时应当总是带上 `ask_id`。**
- 用户在任务已经结束之后（核对通过、停止、或者运行结束后等结果卡的那段时间）才发来 `steer`：执行层不采用，发一条 `refused`（`what` 是 `steer: <原话>`，`why` 是 "the task already finished"）。这是 `task_done` 之后唯一可能出现的 `refused`。
- 每次运行只有一个 `task_done`，而且是最后一个运行中的事件（之后只可能有对结果卡的 `result_response`、迟到插话的 `refused`，以及后到的步骤截图 `shot_ready`）。
- **步骤（M0 加的，不升版本）：** 每个 `act` / `file` 调用是一步，由执行层发（不再由运行时的工具调用发，所以换了运行时也一样）。`step` 多了可选字段：`step_id`（这一步的 id，`step_result` 和 trace 用它对上）、`human`（按请求语言写的一句话：动作、元素的名字和角色、在哪个窗口；不出现元素 id 和 JSON）、`target`（`{id, label, role}`，动作作用的元素，取自调用方上一次看这个窗口的结果）、`plan_step`（调用方说这一步属于计划第几步，从 1 数；只用来显示，不影响同意和核对）。`text` 照旧是动作的 JSON（文件动作是能力名和参数），给现在的 app 用。新种类 `step_result`：`{step_id, status, why?, executor_status?, consequence?}`，status 是 `ok`、`unverified`（做了，没读回来）、`refused`（执行层或用户没让做：用户不同意、要先交计划、只能找证据、停止、锁屏等，执行层自己的状态在 `executor_status`）、`stale`（调用方看过之后界面变了，没做）、`error`。每个 `step` 后面都有一个同 id 的 `step_result`，在下一个 `step` 之前。被改要求拦下的、参数不全的调用不算一步，不发 `step`。执行层的拒绝照旧另发一条 `refused`。和以前不同的两处：做了没读回来不再另发一条带 `status: "unverified"` 的 `step`，由 `step_result` 说；文件动作的 `step` 在动手前发，不再带 `status`，`consequence` 是执行层按结构定的类别（以前是做完后带结果发的）。**现在的 app 受影响：**它只看 `step`、不看 `step_result`，没有 `status` 就当成功，所以文件动作一律显示成绿色的成功行；没做成的文件动作另有一行 `refused`（执行层的拒绝照旧发），但那条绿色行不会变。新界面要按 `step_result` 定一步的结局。**`step_result` 可能缺：**停止时如果有一个动作还在驱动那里没回音，`task_done` 会先写（见第三节「信号」），那一步就没有 `step_result`；`task_done` 之后的事件只进 trace。所以 app 收到 `task_done` 时，要把还没有结局的步骤一并关掉：`task_done` 的 reason 是 "a step was in progress; its result is unknown" 时，那一步写「不确定做没做成」（它的对象在 `changes.unconfirmed` 里），其余按任务的结局显示成「已停下」。`human` 和 `target` 只取调用方做决定时看的那一眼（epoch 对得上），对不上就不带 `target`、元素说成「一个元素」，免得说错是哪个元素。
- **卡片的字段（M0 加的，不升版本）：** `ask.card` 照旧有拼好的 `text`，另外可以带：`plan`（计划卡）：`{steps: [{purpose, class, objects: [{ref, label, owner, marks}], sites: [{host, sends, asks_each}]}], foreground: {apps, note} | null}`。`class` 是执行层定下的后果类别；`objects` 只列卡上写了的对象（解析得到的窗口、标签页、任务目录里的文件），`owner` 是 `user` / `task`，`marks` 是这一步对它做什么：`changes`（改你的东西）、`sends`（从它往外发）、`opens_pages`（在你的这个窗口里打开网页）；`sites` 是这一步打开的每个网站、计划里说发过去的内容（没说是 null）、以及到时候是否还会逐次问（`asks_each`：任务读过材料，打开算往外发）；`foreground` 是只能在前台操作的应用和卡上那句话。`consent`（单步授权卡，`kind: "action"`）：`{action, action_text, target, object, object_label, consequence, outgoing: [{kind, label, value}], site}`；`action` 是动作种类，`action_text` 是不带后果说明的一句话，`target` 是元素名字，`outgoing` 是要发出去的东西逐项列出（`field` 填了的字段、`selected` 选中的一项、`typed` 这次任务打的字、`text` 窗口里的其他文字），`site` 是逐站询问时问的网站。两者都只是 `text` 的拆分，不多说也不少说。
- **成本和判官（M0 加的，不升版本）：** `model_call`：`{call_id, role, model, outcome, tokens_in, tokens_out, cost_usd, latency_ms, step_id?, judge_id?}`，每次模型调用一条：动手的模型每一轮（role `loop`）、判官每一档的每次提问、改写（`transform`）。花费是美元：服务没给就按价目表算，不在表里的是 0。`tokens_in` 是模型读的全部输入，包括从服务的提示缓存里读的那部分；那部分另记在 `cache_read`（动手模型和判官同一个算法）。缓存部分按缓存价算，价目表里没有缓存价就按输入价算，并带 `cost_estimated: true`。`judge`：`{judge_id, question, answer, by, confidence?, tiers: [{tier, outcome, choice, confidence?, settled}], shadow?: {tier, top, agree}, step_id?, ms?}`，每个判官问题一条（缓存命中的不算新问题，不发）；`question` 是问题的种类（`intent` / `outgoing` / `provenance` / `verify` / `evidence` / `other`）；`answer` 是 null 表示哪一档都没能定下来（执行层按保守的一边走）；`tiers` 是问过的每一档和它说了什么、是否由它定下；`shadow` 是抽样让顶档再答一次的比对。这一问的模型调用带同一个 `judge_id`，在步骤里问的带 `step_id`。`task_done` 多了可选的 `usage`：`{calls, tokens_in, tokens_out, cost_usd, by_role}`，这次运行全部模型调用的合计。`task_done` 之后不再发 `model_call`（比赛里晚到的判官回答只记在 `model_calls.jsonl` 和 trace 里）。
- **调用链（M0 加的，旁路文件，不是事件）：** 运行目录里的 `trace.otel.jsonl` 是这次运行的 OpenTelemetry 调用链，按 GenAI 语义约定：`invoke_agent deskmind`（整次运行）→ `deskmind.turn`（模型的一轮）→ `chat <模型>`（动手模型的调用，`gen_ai.*`：模型、输入输出 token）和 `execute_tool <工具>` → `deskmind.step`（一步，带 `deskmind.step_id`）→ `deskmind.classify`、`deskmind.judge <问题>`（带 `deskmind.judge_id`、定下来的档位 `deskmind.tier`、影子比对）→ 判官每档的 `chat <模型>`；`deskmind.ask_user`（等用户答卡）、`deskmind.user_busy`（等用户停手）、`deskmind.perform`（驱动去做，`deskmind.token_kind` 是用到的同意凭证种类：action / object / site / rule / none）；`deskmind.plan`、`deskmind.verify`。每个 span 有父 span、开始结束时间、状态；花费在 `deskmind.cost_usd`（也写 `gen_ai.usage.cost`）。每行是一个 OTLP/JSON 的 ExportTraceServiceRequest，装着刚结束的那个 span（OpenTelemetry collector 的 file exporter 格式）；运行结束时还开着的 span 以错误状态补上结束。`harness.mjs trace export --run <id> --out <文件> [--runs <目录>]` 把一次运行合成一个请求，可以直接 POST 给 Jaeger、Phoenix、Langfuse 的 `/v1/traces`。只写本机，不往外发。`trace.jsonl` 的每一行多了 `span_id`（写这一行时所在的 span）和 `step_id`（在步骤里写的）。
- **光标和每步截图（M0 加的，不升版本；要 hands 的配套改动）：** `step.target` 多了 `rect_norm`（元素在它窗口里的位置，`[x, y, w, h]`，都是 0–1 的比例，给画面上的光标用；app 不用知道窗口在屏幕哪里）和 `frame`（同一个元素在屏幕上的位置，点，左上角为原点），取自调用方上一次观察（hands 的 observe 给窗口的 `frame`、元素的 `rect`）；驱动没给就没有。`step_result` 多了 `shot`（这一步做完后目标窗口的小图，PNG，最长边不超过 1024 像素、不超过 200 KB，路径相对运行目录：`shots/<step_id>.png`；只有改东西的步骤才拍，看一眼、等待、没做成的步骤没有）、`target_frame` 和 `window_frame`（`{x, y, w, h}`，动手前元素和窗口在屏幕上的位置，来自 hands 的回执）。这些只给 app：模型、判官、MCP 的调用方都看不到（执行层把窗口的 `frame` 和观察分开存，回执、核对的证据、判官的问题里都没有；授权卡的 `consent` 字段同样只给 app）。关窗口、没做成（stale、被拒）的步骤不拍，也不要位置。**图是后到的：**hands 先回动作的结果、再在后台拍图，所以 `step_result` 里的 `shot` 可能带 `shot_pending: true`，意思是图还在写；写好后发 `shot_ready {step_id, shot}`。它可能排在之后的事件后面，甚至在 `task_done` 之后（进程还在时）；一直没等到的，app 去 `shot` 指的路径看文件在不在，拍失败就不会有文件。图只存在本机的运行目录里。
- **其余几样（M0 加的，不升版本）：** `ask_void`：`{ask_id, why}`，一张开着的卡没等到回答就放下了，`why` 是 `steer`（用户改了要求；同时照旧发 `resumed{voided}`）、`stop`（用户停止了任务）、`ended`（app 走了，stdin 关了）；之后再发来这张卡的回答不算数。`steered`：`{text}`，用户中途说的话在两步之间交给了任务（从这里起判官按新要求判断）。`verify`：`{verdict, by?, reason, missing_kind?, judge_id?}`，对模型说「做完了」的核对结论；`unknown` 且 `missing_kind` 是 `evidence` 时，之后只能看不能动（app 写「在核对结果」），这期间动作被拒是正常的。`changes`：形状同 `task_done.changes`，另有 `created_windows`，每个改了东西的步骤之后发一次当前的累计值。`resumed`（不带 `ask_id`）多了 `why`：`""`（用户停手了）、`stopped`（任务被停止）、`timed_out`（等了 120 秒用户还在用，这一步被拒，任务继续）。`result_response` 多了 `undone`、`total`、`refused`：撤回了几步、一共几步、停在哪（null 表示全撤回了）；没有撤回时没有这三项。

## 三、控制（control，第 1 版）：app → 执行层

app 往 `app-run` 的 stdin 写，每行一个 JSON。第一行是任务本身（`{raw, config, …}`，或用 `--request <file>` 给），之后是控制行，按 `type` 分四种（`src/protocol/control.ts`）：

| type | 内容 | 什么时候 |
|---|---|---|
| `answer` | `{"type":"answer","ask_id":"ask_…","option":n}` 或 `…,"text":"…"}` | 回答一张卡（`ask` 事件）；`ask_id` 不是当前这张卡的，记一条 `refused`，不算回答 |
| `stop` | `{"type":"stop"}` | 随时：立刻停下，等着回答的卡按「没回答」处理，任务以 stopped 结束 |
| `respond` | `{"type":"respond","option":n}` | 运行结束后、`--linger` 秒内，回答结果卡（比如撤回）。这段时间里别的行（迟到的 answer、不是 JSON 的行）跳过，接着等；等到 respond、stdin 关闭、stop 或时间到为止 |
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

## 会话（第 1 版）：app ↔ 会话进程

**会话**是左栏的一行：一段和云端模型的聊天。每个会话一个常驻进程 `harness.mjs session`，app 往它的 stdin 写控制行，从 stdout 读事件，每行一个 JSON。代码在 `src/session/`（`host.ts` 进程本体、`loop.ts` 一次回复、`context.ts` 上下文和压缩、`log.ts` 历史记录），命令行在 `src/cli/session.ts`。这一版（H1）只聊天，**还没有电脑任务**：模型没有任何工具，系统提示要求它不说自己在电脑上做过什么；电脑任务在 H2 接进来。

**启动：**
- 新会话或按 id 打开：`harness.mjs session [--dir <d>] [--config <c>] [--lang zh|en]`，stdin 第一行是 `{session_id?, config?, lang?, driver?}`。这个 `session_id` 已经有记录就是接着原来的会话，没有就是新会话；不给就生成一个 `ses_xxxxxxxx`。`config` 默认 `ds-flash`（和 `app-run` 一样），`lang` 默认 `zh`，`driver` 留给 H2，现在只读不用。
- 恢复：`harness.mjs session --session <id> [--dir <d>]`，立即开始；之后来的第一行如果不带 `type`，仍然当作上面那种头一行（只用它的 `config`、`lang`）。没有这个会话就退出，退出码 2。
- `session_id` 只能是字母、数字、`_`、`-`，最长 64 个字符（它是文件夹名）。头一行里的 `session_id`、`config`、`lang`、`driver` 有值就必须是字符串，`lang` 只能是 `zh` 或 `en`。不合格时：启动阶段发一条不入库的 `session.error{code:"bad_config"}` 并退出（退出码 2）；恢复后才来的头一行不合格，只回这条错误，设置不变。
- 同一个会话同时只能有一个进程：`sessions/<id>/lock` 里写着进程号。锁是一次建好的：先把进程号写进自己的临时文件，再硬链接成 `lock`（名字已存在就失败），所以谁也读不到一个空的锁。另一个活着的进程占着时，发一条不入库的 `session.error{code:"busy"}` 后退出，退出码 1。占着它的进程已经不在了（被杀掉了），就先把旧锁改名挪开，确认挪走的确实是那个死掉的进程的锁再接过来；挪走的如果是别人刚建的锁，就放回去，自己算 busy。

**历史放在哪：** `<--dir，默认 ~/Library/Application Support/DeskMind>/sessions/<session_id>/session.jsonl`。文件夹权限 0700，文件 0600，只在这台 Mac 上。写法和运行的 `events.jsonl` 一样（`src/protocol/events.ts` 的 EventLog）：每条入库的事件带 `seq`（从 1 起，连续）、`t`（秒）、`session_id`，先写盘、fsync，再发到 stdout。
- **入库：** 用户和助手的最终消息（`session.message`），模型出的错（`session.error` 里的 no_key、key_invalid、network、quota、bad_config）。
- **不入库（没有 `seq`）：** `session.start`、流式的 `session.delta`、对某一行控制的拒绝（not_yet、busy、too_long）。
- 进程在回复中途被杀掉：那段回复从没入库，就没了；用户的那条消息已经入库，留着。重新打开后，这条没得到回复的消息和用户的下一条消息在上下文里连成一条（中间空一行），模型看到的仍然是一问一答交替。进程不会自己补答。

**事件（进程 → app）：**

| kind | 字段 | 入库 | 说明 |
|---|---|---|---|
| `session.start` | `session_id, protocol:{session:1}, last_seq, resumed` | 否 | 进程一开始发一次。`protocol` 只报会话接口的版本：这个进程不说运行的事件和控制（那是 `app-run` 的）。`last_seq` 是盘上最后一条的 `seq`，`resumed` 表示这是已有的会话 |
| `session.message` | `msg_id, role: user\|assistant, text, reply_to?, model?, stopped?, truncated?, via?` | 是 | 最终消息。`reply_to` 是助手消息回答的那条用户消息；`model` 是 `<服务>\|<模型>`；`stopped: true` 是用户停下了，`text` 是停下时已经说出的部分（可以是空的）；`truncated: true` 是到了 64k 字被截断（或模型自己到了输出上限）；`via` 留给 H2（这条消息是怎么来的，比如电脑任务） |
| `session.delta` | `msg_id, text, offset` | 否 | 流式输出，大约每 50 毫秒合并成一条。`offset` 是这段文字在整条回复里的起点，所以 app 能发现重复和缺口。每次回复先发一条 `text:""、offset:0` 的空 delta，表示「开始回复了」（app 显示「思考中」）。同一个 `msg_id` 的所有 delta 按 `offset` 拼起来，就是最后那条 `session.message` 的 `text`：服务最后给的全文和流式发出的对不上时，在最终消息之前再发一条 `offset:0` 的 delta，内容是全文，app 用它整个替换 |
| `session.error` | `code, text, msg_id?, reply_to?, control?` | 见上 | `code` 见下表。`msg_id` 是失败的那次回复：它之前发过的 delta 作废，app 把那个正在长的气泡去掉。`reply_to` 是没得到回答的用户消息。`control` 是被拒绝的那行控制的 `type` |

`session.error` 的 `code`：

| code | 意思 | 入库 |
|---|---|---|
| `no_key` | 这个配置用的服务没有 key（`text` 写的是缺哪个环境变量，不含 key 本身） | 是 |
| `key_invalid` | 服务拒绝了 key（HTTP 401 / 403） | 是 |
| `quota` | 余额或额度不够、被限流（HTTP 402 / 429） | 是 |
| `network` | 连不上、超时、服务出错（5xx），以及其他没归类的失败 | 是 |
| `bad_config` | 不认识的配置名，配置里不是带 key 的服务，或者服务说没有这个模型（404） | 是 |
| `not_yet` | 这一行是 H2 的控制（`cua`、`steer`、`answer`、`respond`、`queue_*`），这一版还做不了 | 否 |
| `busy` | 上一条回复还没完就又来了 `say`（先 `stop` 或等它说完）；或者会话被另一个进程占着 | 否 |
| `too_long` | 用户消息超过 32k 字（字符数）。这条消息不入库，app 留着输入框里的字 | 否 |

前五个出现时，用户那条消息已经入库了（`reply_to` 指向它）。错误的 `text` 最多 300 字，而且去掉了 key：环境变量里各家服务 key 的实际值（服务可能把收到的 key 原样写进错误里），以及看起来像 key 的 `sk-…`、`Bearer …`。`model-check` 用的是同一个函数（`src/gateway/index.ts` 的 `redactKeys`）。

**控制（app → 进程）：**

| type | 内容 | 说明 |
|---|---|---|
| `say` | `{"type":"say","text":"…"}` | 用户发一条消息：先入库，再开始回复。一次只回复一条 |
| `stop` | `{"type":"stop"}` | 停下正在进行的回复：已经说出的部分作为 `stopped: true` 的消息入库。没有回复在进行时什么也不做。模型已经说完、只是结果还没处理时到的 stop 不算，那条消息照常入库，不带 `stopped` |
| `attach` | `{"type":"attach","after_seq":n}` | 补发：把 `seq` 大于 n 的入库事件按顺序重发一遍（不重复、不跳号）。如果正有回复在进行，再发一条 `offset:0` 的 delta，内容是到现在为止说出的全部文字，之后的 delta 接着这个 offset 往下 |
| `end` | `{"type":"end"}` | 结束：停下正在进行的回复（同 `stop`，部分入库），然后退出 |
| `cua`、`steer`、`answer`、`respond`、`queue_*` | | H2 的，现在回 `session.error{code:"not_yet"}` |

别的 `type`、不是 JSON 的行、没有 `type` 的对象一律忽略（兼容规则同第四节）。

**模型和上下文：**
- 用配置里 `goal` 角色的模型，经 pi-agent-core 的 `runAgentLoop` 调，流式收 `text_delta`。没有工具。key 和服务地址从环境变量来（和 `app-run` 一样）。
- 系统提示：DeskMind 是用户 Mac 上的个人助手（末尾写着今天的本地日期）；它只能通过电脑任务操作电脑，而电脑任务还没接进对话，所以不能说自己在电脑上做了什么、看到了屏幕或文件里的什么；用户要它动手时直说现在做不到。`lang` 决定系统提示用中文还是英文。
- 上下文 = 系统提示 + 入库的消息。超过模型窗口的 60%（按一个字算一个 token）时，从最早的开始整轮丢掉（一轮 = 用户的话和对它的回复），一次丢到这个额度的一半左右，系统提示末尾加一句「更早的 n 条对话已省略」（n 是丢掉的消息条数）。这样丢的位置隔好几轮才动一次，模型读到的开头在这几轮里不变，服务的提示缓存用得上。丢到哪里是把对话一轮一轮重放算出来的（每轮的长度只算一次），同样的历史总得到同样的结果。最新的那一轮（含最新的用户消息）永远不丢。停下前一个字都没说的回复不进上下文；说了一半的进上下文，并注明「这条回复被用户中途停下了」。
- 一条回复最多 64k 字，到了就截断并停止生成，入库时带 `truncated: true`。
- 每次回复的模型调用记一行到同一个文件夹的 `model_calls.jsonl`（权限 0600），格式和运行的一样，`role` 是 `session`：`tokens_in`（模型读的全部输入，含提示缓存的部分，那部分另记在 `cache_read`）、`tokens_out`、`cost_usd`（服务没给就按价目表算）、`latency_ms`、`sent_chars`、`outcome`，以及 `msg_id`、`reply_to`。

**退出：** stdin 关了（app 走了）或收到 `end`，而且没有回复在进行，进程就退出（退出码 0）。stdin 关的时候正有回复，就等它说完、入库之后再退出。SIGINT / SIGTERM 等同 `end`。

**会话列表：** `harness.mjs sessions list [--dir <d>]` 输出一个 JSON 数组，最新的在前：`{session_id, title, updated_at, last_message}`。`title` 是第一条用户消息的前 40 个字（超出加「…」，空白压成一个空格），`updated_at` 是最后一条入库事件的 `t`（秒），`last_message` 是 `{role, text}`（前 200 个字），没有消息时为 null。只读，不加锁。
