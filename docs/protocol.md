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
- 种类：start、preparing、plan、step、step_result、ask、ask_void、waiting、resumed、consent、refused、steered、verify、changes、model_call、judge、shot_ready、answer_given、task_done、result_response、result_card_closed。app 不认识的种类直接忽略。
- 中断后对不上的卡（见第一节）用已有的 `action` 种类，选项种类是 `approve` / `cancel`。`task_done` 的 status 是 `cancelled`、reason 是 `needs_reconciliation` 时，意思是任务停在等用户查看这个文件。
- `resumed` 可以带 `voided: "steer"`（P1 加的可选字段）：这张卡没等到回答就作废了，因为用户中途改了要求。app 收到就把卡关掉；之后再发来这张卡的回答，会被记成一条 `refused`，不算数。**一旦有卡作废过，这次运行剩下的时间里，不带 `ask_id` 的回答一律被拒绝（`refused`），因为分不清它是不是给作废那张卡的迟到回答。所以 app 回答卡片时应当总是带上 `ask_id`。**
- 用户在任务已经结束之后（核对通过、停止、或者运行结束后等结果卡的那段时间）才发来 `steer`：执行层不采用，发一条 `refused`（`what` 是 `steer: <原话>`，`why` 是 "the task already finished"）。这是 `task_done` 之后可能出现的两种 `refused` 之一；另一种是给已经作废（过期、改要求）的卡的迟到回答，见下「卡片过期」。
- **结果卡（M2 H2，负责人 10-24）：** 任务只要改了东西，不管怎么结束（`succeeded`、`failed`、`stopped`、`cancelled`、`unconfirmed`、`environment`，包括信号的时限到了强行写的 `task_done`），`task_done.result_card` 都有一张结果卡；以前只有 `succeeded` 才有。「改了东西」只有一条规则，从执行层的日志（`journal.jsonl`）读（`src/executor/possibly.ts`）：可能改东西的动作（不是只看的界面动作、不是只读的文件动作）交出去之前记一条 `intent`，有了结果记一条 `receipt`；**有 `intent`、又没有一条明说「什么都没发生」的 `receipt`，这一步就算可能做了**。明说没发生的只有两种：动手的一方说它根本没做（`receipt.performed: false`），和重启时核对出文件那一步没发生（`finding: "not_happened"`）。`performed: false` 从哪来（都在 `src/executor/possibly.ts` 的 `saysNotPerformed` 一处）：驱动回复里带 `performed: false`（比如用户正在用电脑、hands 在动手之前就拒了：要重新看、没有后台通道、窗口找不到），不管 status 是什么；协议规定为「动手之前就拒绝」的回复 status，目前只有 `unsupported`（驱动做不了这类动作）；文件能力干净地失败、保证什么都没留下时（比如输出先写到临时文件、再一步原子地放到位，放不进去；或者检查没通过）在结果里带 `performed: false`。回执里的 `status` 是这一步最后的结果（读回之后），卡片上「做了」和撤回都按它，驱动原话的 status 另记在 `driver_status`。状态名字（`ok`、`error`、锁屏……）不参与判断；没有 `receipt`（进程没了、动作还在驱动那里、文件能力写到一半抛了错）都算可能做了。没有可能做了的步骤就是 `null`。卡上逐条列出这些步骤：`receipt` 是 `ok` 的写在「做了：」，其余写在「做没做成没法确认：」。每一步的 `step_result.possibly_done`（加的可选字段）就是这条规则对这一步的答案，没有这个字段按「可能做了」算。执行层没写 `task_done` 就没了时，结果卡由会话写在 `session.task_end.result_card` 里（见会话一节）。
  - 撤回选项（`undo`）只在每一个可能做了的步骤都有撤回的办法时才有：文件动作走它的能力的撤回（新建、移动、复制、追加、新建文件夹），任务自己开的窗口关掉——都要那一步的 `receipt` 是 `ok`；写到一半抛错的文件动作、结果不明的、中断前那次运行做的，都没有办法。有界面操作、有一步做没做成不知道（`unverified`，或停下时还在途中）时整个任务都不能撤回，卡上的字写明为什么（`（界面上的操作撤不回）` 这类）。
  - 不是 `succeeded` 时卡的第一行说任务怎么结束的（「任务停下了；已经做了的改动：」这类），只是给人看的字。
  - `task_done.undo_until`（加的可选字段）：有撤回选项、执行层会等结果卡时，等到什么时候（1970 年起的秒，和 `t` 一样按墙上时钟）。等多久见第三节 `respond`。
  - 没有 `undo_until` 就不给撤回：执行层不会等回答（`--linger 0`、收到了信号、stdin 已经关了）时，卡上不放撤回选项，字里写明「这次运行结束后不再等回答，撤回用不了」；会话因为锁改不成 `lingering` 而不让它等时，转出去的卡也去掉撤回选项、加上同样的话。
- 每次运行只有一个 `task_done`，而且是最后一个运行中的事件（之后只可能有对结果卡的 `result_response`、迟到插话的 `refused`，以及后到的步骤截图 `shot_ready`）。
- **停下的原因 `cause`（加的可选字段，不升版本）：** `task_done.reason` 只是给人看的文字，措辞会变，app 不要拿它做字符串比对。要按原因分情况（状态点显示「锁屏」、最后一步写「不确定做没做成」），看 `task_done.cause`。它是一个固定的取值集合（`src/protocol/computer.ts` 的 `STOP_CAUSES`），只在结束任务的那段代码本来就知道原因时才填，从不从 reason 的文字里推出来：
  - `screen_locked`：发现屏幕锁了（开始时，或某一步前后）。status 是 `environment`。
  - `last_step_unknown`：任务结束时有一步正在做，它做没做成不知道：停止时有一个动作交给了驱动、等不到回执（见第三节「信号」，这个动作的对象在 `changes.unconfirmed` 里）；会话替任务记结局时，有一步开始了（`step`）还没有结局（`step_result`），也用它（见「电脑任务（H2）」）。
  - `user_stopped`：用户要停：一行 `stop`（带 `app_gone` 的除外）、`app-run` 收到 SIGINT（命令行里的 ^C）、用户在卡片上选了「取消」，或者运行时 `finish` 的 outcome 是 `stopped`（用户在卡上用自己的话说了停）。后两种 status 是 `cancelled`。这时每一步的结局都已知道。
  - 没有 `cause`：普通的失败或正常结束。app 走了引起的停止也不填，因为没有人要求停，正在做的那一步照旧等到了回执：stdin 或 stdout 关闭、带 `app_gone` 的 `stop` 行（会话因为 app 结束或离开而停掉它的任务时发的）、SIGTERM（小助手退出，或者新的会话进程接手时停掉旧的执行层）。
  - 以后可能加新的取值；app 不认识的值按没有 `cause` 处理。执行层自己的动作结果（`act` 的返回）里也有同名的可选字段，锁屏时是 `screen_locked`。
- **步骤（M0 加的，不升版本）：** 每个 `act` / `file` 调用是一步，由执行层发（不再由运行时的工具调用发，所以换了运行时也一样）。`step` 多了可选字段：`step_id`（这一步的 id，`step_result` 和 trace 用它对上）、`human`（按请求语言写的一句话：动作、元素的名字和角色、在哪个窗口；不出现元素 id 和 JSON）、`target`（`{id, label, role}`，动作作用的元素，取自调用方上一次看这个窗口的结果）、`plan_step`（调用方说这一步属于计划第几步，从 1 数；只用来显示，不影响同意和核对）。`text` 照旧是动作的 JSON（文件动作是能力名和参数），给现在的 app 用。新种类 `step_result`：`{step_id, status, why?, executor_status?, consequence?}`，status 是 `ok`、`unverified`（做了，没读回来）、`refused`（执行层或用户没让做：用户不同意、要先交计划、只能找证据、停止、锁屏等，执行层自己的状态在 `executor_status`）、`stale`（调用方看过之后界面变了，没做）、`error`。每个 `step` 后面都有一个同 id 的 `step_result`，在下一个 `step` 之前。被改要求拦下的、参数不全的调用不算一步，不发 `step`。执行层的拒绝照旧另发一条 `refused`。和以前不同的两处：做了没读回来不再另发一条带 `status: "unverified"` 的 `step`，由 `step_result` 说；文件动作的 `step` 在动手前发，不再带 `status`，`consequence` 是执行层按结构定的类别（以前是做完后带结果发的）。**现在的 app 受影响：**它只看 `step`、不看 `step_result`，没有 `status` 就当成功，所以文件动作一律显示成绿色的成功行；没做成的文件动作另有一行 `refused`（执行层的拒绝照旧发），但那条绿色行不会变。新界面要按 `step_result` 定一步的结局。**`step_result` 可能缺：**停止时如果有一个动作还在驱动那里没回音，`task_done` 会先写（见第三节「信号」），那一步就没有 `step_result`；`task_done` 之后的事件只进 trace。所以 app 收到 `task_done` 时，要把还没有结局的步骤一并关掉：`task_done` 的 `cause` 是 `last_step_unknown` 时（reason 这时写 "a step was in progress; its result is unknown"，只供显示），那一步写「不确定做没做成」（它的对象在 `changes.unconfirmed` 里），其余按任务的结局显示成「已停下」。`human` 和 `target` 只取调用方做决定时看的那一眼（epoch 对得上），对不上就不带 `target`、元素说成「一个元素」，免得说错是哪个元素。
- **卡片的字段（M0 加的，不升版本）：** `ask.card` 照旧有拼好的 `text`，另外可以带：`plan`（计划卡）：`{steps: [{purpose, class, objects: [{ref, label, owner, marks}], sites: [{host, sends, asks_each}]}], foreground: {apps, note} | null}`。`class` 是执行层定下的后果类别；`objects` 只列卡上写了的对象（解析得到的窗口、标签页、任务目录里的文件），`owner` 是 `user` / `task`，`marks` 是这一步对它做什么：`changes`（改你的东西）、`sends`（从它往外发）、`opens_pages`（在你的这个窗口里打开网页）；`sites` 是这一步打开的每个网站、计划里说发过去的内容（没说是 null）、以及到时候是否还会逐次问（`asks_each`：任务读过材料，打开算往外发）；`foreground` 是只能在前台操作的应用和卡上那句话。`consent`（单步授权卡，`kind: "action"`）：`{action, action_text, target, object, object_label, consequence, outgoing: [{kind, label, value}], site}`；`action` 是动作种类，`action_text` 是不带后果说明的一句话，`target` 是元素名字，`outgoing` 是要发出去的东西逐项列出（`field` 填了的字段、`selected` 选中的一项、`typed` 这次任务打的字、`text` 窗口里的其他文字），`site` 是逐站询问时问的网站。两者都只是 `text` 的拆分，不多说也不少说。
- **成本和判官（M0 加的，不升版本）：** `model_call`：`{call_id, role, model, outcome, tokens_in, tokens_out, cost_usd, latency_ms, step_id?, judge_id?}`，每次模型调用一条：动手的模型每一轮（role `loop`）、判官每一档的每次提问、改写（`transform`）。花费是美元：服务没给就按价目表算，不在表里的是 0。`tokens_in` 是模型读的全部输入，包括从服务的提示缓存里读的那部分；那部分另记在 `cache_read`（动手模型和判官同一个算法）。缓存部分按缓存价算，价目表里没有缓存价就按输入价算，并带 `cost_estimated: true`。`judge`：`{judge_id, question, answer, by, confidence?, tiers: [{tier, outcome, choice, confidence?, settled}], shadow?: {tier, top, agree}, step_id?, ms?}`，每个判官问题一条（缓存命中的不算新问题，不发）；`question` 是问题的种类（`intent` / `outgoing` / `provenance` / `verify` / `evidence` / `other`）；`answer` 是 null 表示哪一档都没能定下来（执行层按保守的一边走）；`tiers` 是问过的每一档和它说了什么、是否由它定下；`shadow` 是抽样让顶档再答一次的比对。这一问的模型调用带同一个 `judge_id`，在步骤里问的带 `step_id`。`task_done` 多了可选的 `usage`：`{calls, tokens_in, tokens_out, cost_usd, by_role}`，这次运行全部模型调用的合计。`task_done` 之后不再发 `model_call`（比赛里晚到的判官回答只记在 `model_calls.jsonl` 和 trace 里）。
- **调用链（M0 加的，旁路文件，不是事件）：** 运行目录里的 `trace.otel.jsonl` 是这次运行的 OpenTelemetry 调用链，按 GenAI 语义约定：`invoke_agent deskmind`（整次运行）→ `deskmind.turn`（模型的一轮）→ `chat <模型>`（动手模型的调用，`gen_ai.*`：模型、输入输出 token）和 `execute_tool <工具>` → `deskmind.step`（一步，带 `deskmind.step_id`）→ `deskmind.classify`、`deskmind.judge <问题>`（带 `deskmind.judge_id`、定下来的档位 `deskmind.tier`、影子比对）→ 判官每档的 `chat <模型>`；`deskmind.ask_user`（等用户答卡）、`deskmind.user_busy`（等用户停手）、`deskmind.perform`（驱动去做，`deskmind.token_kind` 是用到的同意凭证种类：action / object / site / rule / none）；`deskmind.plan`、`deskmind.verify`。每个 span 有父 span、开始结束时间、状态；花费在 `deskmind.cost_usd`（也写 `gen_ai.usage.cost`）。每行是一个 OTLP/JSON 的 ExportTraceServiceRequest，装着刚结束的那个 span（OpenTelemetry collector 的 file exporter 格式）；运行结束时还开着的 span 以错误状态补上结束。`harness.mjs trace export --run <id> --out <文件> [--runs <目录>]` 把一次运行合成一个请求，可以直接 POST 给 Jaeger、Phoenix、Langfuse 的 `/v1/traces`。只写本机，不往外发。`trace.jsonl` 的每一行多了 `span_id`（写这一行时所在的 span）和 `step_id`（在步骤里写的）。
- **光标和每步截图（M0 加的，不升版本；要 hands 的配套改动）：** `step.target` 多了 `rect_norm`（元素在它窗口里的位置，`[x, y, w, h]`，都是 0–1 的比例，给画面上的光标用；app 不用知道窗口在屏幕哪里）和 `frame`（同一个元素在屏幕上的位置，点，左上角为原点），取自调用方上一次观察（hands 的 observe 给窗口的 `frame`、元素的 `rect`）；驱动没给就没有。`step_result` 多了 `shot`（这一步做完后目标窗口的小图，PNG，最长边不超过 1024 像素、不超过 200 KB，路径相对运行目录：`shots/<step_id>.png`；只有改东西的步骤才拍，看一眼、等待、没做成的步骤没有）、`target_frame` 和 `window_frame`（`{x, y, w, h}`，动手前元素和窗口在屏幕上的位置，来自 hands 的回执）。这些只给 app：模型、判官、MCP 的调用方都看不到（执行层把窗口的 `frame` 和观察分开存，回执、核对的证据、判官的问题里都没有；授权卡的 `consent` 字段同样只给 app）。关窗口、没做成（stale、被拒）的步骤不拍，也不要位置。**图是后到的：**hands 先回动作的结果、再在后台拍图，所以 `step_result` 里的 `shot` 可能带 `shot_pending: true`，意思是图还在写；写好后发 `shot_ready {step_id, shot}`。它可能排在之后的事件后面，甚至在 `task_done` 之后（进程还在时）；一直没等到的，app 去 `shot` 指的路径看文件在不在，拍失败就不会有文件。图只存在本机的运行目录里。
- **其余几样（M0 加的，不升版本）：** `ask_void`：`{ask_id, why}`，一张开着的卡没等到回答就放下了，`why` 是 `steer`（用户改了要求；同时照旧发 `resumed{voided}`）、`stop`（用户停止了任务）、`ended`（app 走了，stdin 关了；任务随即停下，见第三节「app 走了」）、`timeout`（M2 加的，见下「卡片过期」）；之后再发来这张卡的回答不算数。`steered`：`{text}`，用户中途说的话在两步之间交给了任务（从这里起判官按新要求判断）。`verify`：`{verdict, by?, reason, missing_kind?, judge_id?}`，对模型说「做完了」的核对结论；`unknown` 且 `missing_kind` 是 `evidence` 时，之后只能看不能动（app 写「在核对结果」），这期间动作被拒是正常的。`changes`：形状同 `task_done.changes`，另有 `created_windows`，每个改了东西的步骤之后发一次当前的累计值。`resumed`（不带 `ask_id`）多了 `why`：`""`（用户停手了）、`stopped`（任务被停止）、`timed_out`（等了 120 秒用户还在用，这一步被拒，任务继续）。`result_response` 多了 `undone`、`total`、`refused`：撤回了几步、一共几步、停在哪（null 表示全撤回了）；没有撤回时没有这三项。

- **卡片过期（M2 H1，负责人 10-24，加的取值和控制，不升版本）：** 时间到了不替用户回答。
  - 只有动作卡（单个动作的同意卡，`card.kind` 为 `action`、带 `card.consent`）会过期；计划卡、问题卡、选择卡、中断后对不上的卡一直等。
  - 动作卡开着 10 分钟没人答（按墙上时钟算：Mac 睡着的时间也算，醒来后一秒内就过期），执行层发 `resumed{ask_id, voided:"timeout"}` 和 `ask_void{ask_id, why:"timeout"}`。什么都没签、什么都没做。醒来后还没到那一秒的检查就来了回答或 `reask`：先按墙上时钟看有没有过期，过了就当场过期（回答被拒，`reask` 照常重新问），不会被当成回答。
  - 之后任务停在原地，照旧占着这台 Mac（会话的电脑锁还是 acting），不动手，直到用户：点「现在回答」（控制行 `reask`）、插话（`steer`，那一步不做，按新要求重新决定）、或停止（`stop`，任务以 stopped 结束）。stdin 关闭同停止。
  - `reask`：执行层把这一步在卡片当时的画面上重新交给执行器，不带同意：画面没变，出一张新卡（新的 `ask_id`，重新计 10 分钟）；画面变了，这一步按 stale 回来（`step_result` stale，没做），运行时重新看、重新决定，要动手就再出卡。没有过期的卡时（卡还开着，或者根本没有卡）来了 `reask`，发一条 `refused`（`what` 是 `reask`，`why` 说原因），什么都不做。
  - 每一条回答都只有一个结局：交给它那张还开着的卡（`resumed`），或者被拒（`refused{what:"answer for <ask_id>"` 或 `"an answer without ask_id", why}`，`why` 写明原因：过期、作废、已经答过、任务停了、没有这张卡），不管几行是不是在同一块 stdin 里一起到。每一行回答在到达的那一刻就定下结局，不排队：是现在开着的那张卡的（带它的 `ask_id`，或者还没有卡作废过时不带 `ask_id`），就交给它，这张卡随即算答过；否则立刻拒，原因从卡的记录里取（那张卡过期了、作废了、答过了、停了、app 走了；没有这张卡；作废过之后不带 `ask_id`；任务停了或已经结束）。任务停下、app 走了、`task_done` 之后也一直这样拒，直到进程退出，不会悄悄丢掉；和请求同一块到的回答也一样。任务不管怎么结束（停下、app 走了、运行时死了、执行层出错），开着的卡都当场放下并发 `ask_void`（停下是 `stop`，其余是 `ended`）。一张卡在发出 `ask`（和 `waiting`）之前就已经登记好，app 在收到 `ask` 的同一刻就回答也算数；关卡时先注销、再发 `ask_void` / `resumed`。

## 三、控制（control，第 1 版）：app → 执行层

app 往 `app-run` 的 stdin 写，每行一个 JSON。第一行是任务本身（`{raw, config, …}`，或用 `--request <file>` 给），之后是控制行，按 `type` 分五种（`src/protocol/control.ts`）：

- **请求里的 `context`（H2 加的，可选，不升版本）：** 会话里的模型开电脑任务时，它对要做的事的转述放在这里，`raw` 只放用户自己的原话。运行时只在给模型的第一条消息里显示它，标明「助手的转述，不是用户原话（以用户的要求为准）」；判官当作用户的话的只有 `raw`、之后的 steer 和卡片上的回答。执行层把 `context` 当作**读过的材料**（和读过的文件、窗口一样）：它是模型写的，可能带着前一个任务读到、经结果摘要回到聊天模型的内容。所以带 `context` 的运行一开始就有材料，打开没有批准过的网站要问出处判官（以 `raw` 为准），判官说不清就是往外发，要先有计划、出卡（review of #54）。

| type | 内容 | 什么时候 |
|---|---|---|
| `answer` | `{"type":"answer","ask_id":"ask_…","option":n}` 或 `…,"text":"…"}` | 回答一张卡（`ask` 事件）；`ask_id` 不是当前这张卡的，记一条 `refused`，不算回答 |
| `stop` | `{"type":"stop"}`，或 `{"type":"stop","app_gone":true}` | 随时：立刻停下，等着回答的卡按「没回答」处理，任务以 stopped 结束。停下之后执行层不再问任何判官、不再找模型改写：每个判官问题（意图、会不会发出去、出处、计划的依据、结束时的核对）和改写在发出前都看停止信号，已经发出的被中止，答案按「没答上」处理，这一步以 stopped 结束（停下之前开始的那一步也一样：用户的话、窗口里的字、要发出去的内容不会在停下之后再交给模型）。`app_gone`（加的可选字段，不升版本）表示不是用户要停，是 app 结束或离开了（会话进程这样发）：`task_done` 不带 `cause`、reason 是 "the app went away (the session stopped its task)"；不认识这个字段的旧执行层照普通 stop 处理。**结果卡在等回答时**（`task_done` 之后），来一行 `stop` 就结束等待：卡和它的撤回都关掉，之后的 `respond` 不再处理——不管任务之前是不是被停下的（停下任务的那一行 stop 只结束任务，结果卡照样能撤回）；撤回已经在做时来的 stop 不打断它，撤回做完、写了 `result_response` 才结束；第三、第四行 stop 什么都不改 |
| `respond` | `{"type":"respond","option":n}` | 运行结束后、`--linger` 秒内（按墙上时钟：Mac 睡着的时间也算，醒来一秒内到期；到 `task_done.undo_until` 为止），回答结果卡（比如撤回）。**送到的每一个 respond 都有且只有一个 `result_response`**（除非进程死了）。respond 一到先按墙上时钟看有没有过 `undo_until`（醒来后那一秒的检查还没跑时也一样）：过了就什么都不撤，回 `result_response{picked, undone: 0, total, refused: "expired"}`。到了 `undo_until`，执行层发一条 `result_card_closed{why:"expired"}`（加的种类），之后还读到的 respond 一律这样回 "expired"，直到 stdin 关闭（最多再读 2 秒）；会话收到这条就把卡记成过期、不再转 respond，并关掉它的 stdin。这段时间里别的行（迟到的 answer、不是 JSON 的行）跳过，接着等；等到 respond、stdin 关闭、stop 或时间到为止 |
| `reask` | `{"type":"reask"}` | 「现在回答」（M2 加的，不升版本）：一张动作卡过期了（`ask_void{why:"timeout"}`），重新看、重新问，见第二节「卡片过期」。没有过期的卡时记一条 `refused`，不做别的 |
| `steer` | `{"type":"steer","text":"…"}` | 运行中用户改了要求（P1 起交给执行层）。正在做的那一步照旧做完，新要求在两步之间才生效；运行时在新要求生效前已经决定的下一步不做，回给它的是新要求。判官看得到原来的要求和之后每一次改动。开着的卡片立即作废（`resumed` 带 `voided`），那一步按新要求重新决定，要的话再问一次。新要求一生效，之前计划签的凭证（对象、网站，以及计划卡上写的发过去的内容）全部作废：用户可能刚说了「别动这个窗口了」。之后要用户同意的步骤，先交新计划、出新的计划卡；用户在单独的卡上同意过的网站（逐次批准的）照旧有效 |

第 1 版仍然认识加 `type` 之前的写法，Swift 小助手可以以后再改：`{"stop":true}` 是 stop，`{"respond":n}` 是 respond，其他没有 `type` 的对象（`{ask_id, option}`、`{ask_id, text}`、`{text}`）是 answer。带着不认识的 `type` 的行直接忽略。

**信号：** `app-run` 收到 SIGINT 或 SIGTERM，走的是和 stop 行同一个只生效一次的停止：整次运行只有一条 `refused`（by user），reason 用最先要求停的那一方的（stop 行是 "stopped by the app"，信号是 "stopped by SIGTERM" 这类）。之后写 `task_done`（status `stopped`），退出码 0。
- 运行时自己结束得快（通常几十毫秒），就按它的结果写，写完马上退出。
- 0.8 秒时还没结束：如果有一个改东西的动作已经交给驱动、还没回音（hands 一个动作最长可以等 120 秒，它可能在「停下」之后才生效），就再等它的回执，最多 10 秒。等到了，照常结束；等不到，`task_done` 的 `cause` 是 `last_step_unknown`（reason 写 "a step was in progress; its result is unknown"），并把这个动作的对象列进 `changes.unconfirmed`，不说成干净地停了。等到了的、或者没有这样的动作的：SIGINT 的 `cause` 是 `user_stopped`，SIGTERM 的没有 `cause`。没有这样的动作，就直接写 `task_done` 退出。
- 第二个信号：不再等。`task_done` 还没写的就写上（规则同上），然后立刻退出，不等 stdout 写完。
- 还没读到任务就收到信号：直接退出。
- **读 stdout 的一方没了（H2 加的）：** 写事件时 stdout 报错（EPIPE：会话进程或 app 死了），按 stop 行同样处理：整次运行停下（reason "the app went away (stdout closed)"），正在驱动那里的动作照旧等它的回执，事件只写进运行目录的 `events.jsonl`，不再写 stdout；之后照常写 `task_done` 退出（退出码 0）。
- **app 走了（stdin 关闭，H2 改的，负责人 10-21：小助手退出，它正在跑的任务停下）：** 运行中 stdin 关闭，等同一行 stop：开着的卡先放下（`ask_void{why:"ended"}`），然后整次运行停下（reason "the app went away (stdin closed)"，一条 `refused` by user），正在驱动那里的动作照旧等它的回执，写 `task_done`（status `stopped`）后退出。以前 stdin 关闭只放下卡片、任务接着跑（还会接着调模型、动手），已经改掉。`task_done` 之后（等结果卡的那段时间）stdin 关闭只是结束等待。所以从命令行跑执行层时 stdin 要一直开着（比如 `--request <file>` 时不要接 `< /dev/null`）。

## 四、兼容规则

- **加东西不升版本：** 新的事件种类、新的可选字段、新的工具、新的控制类型。读的一方必须忽略自己不认识的种类、字段和类型。
- **删、改名、改含义要升主版本：** 去掉一个工具或事件种类，改字段名，改一个字段或工具的意思（比如后果类别的顺序、一个状态值代表什么），必填字段换了格式。
- **旧版本再支持一个周期：** 升版本之后，上一版在下一个发布周期里照样能用（和控制第 1 版接受不带 `type` 的行一样），之后才去掉。
- 三个接口各自计版本，互不牵连。MCP 本身的版本（`2025-06-18`）跟着 MCP 规范走，和这里的版本无关。

## 会话（第 1 版）：app ↔ 会话进程

**会话**是左栏的一行：一段和云端模型的聊天。每个会话一个常驻进程 `harness.mjs session`，app 往它的 stdin 写控制行，从 stdout 读事件，每行一个 JSON。代码在 `src/session/`（`host.ts` 进程本体、`loop.ts` 一次回复、`context.ts` 上下文和压缩、`log.ts` 历史记录、`task.ts` 电脑任务用的锁和执行层进程），命令行在 `src/cli/session.ts`。H1 只聊天；H2（10-22）把电脑任务接进来：模型有一个工具 `computer_task`，用户有 `/cua`，见下面「电脑任务（H2）」。H2 的东西都是加的（新的事件种类、控制类型、可选字段），按第四节不升版本。

**启动：**
- 新会话或按 id 打开：`harness.mjs session [--dir <d>] [--config <c>] [--lang zh|en]`，stdin 第一行是 `{session_id?, config?, lang?, driver?, scope?}`。这个 `session_id` 已经有记录就是接着原来的会话，没有就是新会话；不给就生成一个 `ses_xxxxxxxx`。`config` 默认 `ds-flash`（和 `app-run` 一样），`lang` 默认 `zh`（重新打开时的默认见下一条「设置的先后」）。`driver`（`sim` / `hands`）和 `scope`（任务目录）原样放进每个电脑任务的请求；不给时执行层用它自己的默认（`sim`，没有任务目录）。
- 恢复：`harness.mjs session --session <id> [--dir <d>]`，立即开始；之后来的第一行如果不带 `type`，仍然当作上面那种头一行（只用它的 `config`、`lang`、`driver`、`scope`）。没有这个会话就退出，退出码 2。
- **设置的先后（`config`、`lang`，加的，不升版本）：** 会话的设置可以在进程活着时用 `set_config` 改（见控制表），每次都入库一条 `session.config`。打开（新开、按 id 打开、`--session` 恢复后的头一行）时，每一项各自按这个顺序取：① 这次打开自己给的（头一行的 `config` / `lang`，或命令行的 `--config` / `--lang`）；② 没给就取历史里最后一条 `session.config` 的；③ 都没有就是默认（`ds-flash`、`zh`）。① 和最后一条 `session.config` 不一样时，进程一开始（`session.start` 之后、补记之前；恢复后才来的头一行，在读到它时）再入库一条 `session.config{by:"open"}`，所以之后不带设置的打开拿到的是最近用过的那个，不会退回更早的 `set_config`。历史里还没有 `session.config` 时什么都不存（和以前一样）。所以：app 想沿用会话里存着的设置（比如用户关掉了模型，`config: null`），重新打开时就**不要**带 `config` / `lang`；带了就以带的为准。头一行不能表示「没有模型」（`config` 只能是字符串）：要以没有模型的状态打开，就在头一行之后紧接着发 `set_config{config:null}`，控制按顺序处理，它前面没有别的控制行时不会有任何一轮模型调用。
- `session_id` 只能是字母、数字、`_`、`-`，最长 64 个字符（它是文件夹名）。头一行里的 `session_id`、`config`、`lang`、`driver`、`scope` 有值就必须是字符串，`lang` 只能是 `zh` 或 `en`，`config`（以及命令行的 `--config`）必须合乎配置的写法（见控制表 `set_config`：它会原样入库）。不合格时：启动阶段发一条不入库的 `session.error{code:"bad_config"}` 并退出（退出码 2）；恢复后才来的头一行不合格，只回这条错误，设置不变。
- 同一个会话同时只能有一个进程：`sessions/<id>/lock` 里写着进程号。锁是一次建好的：先把进程号写进自己的临时文件，再硬链接成 `lock`（名字已存在就失败），所以谁也读不到一个空的锁。另一个活着的进程占着时，发一条不入库的 `session.error{code:"busy"}` 后退出，退出码 1。占着它的进程已经不在了（被杀掉了），就先把旧锁改名挪开，确认挪走的确实是那个死掉的进程的锁再接过来；挪走的如果是别人刚建的锁，就放回去，自己算 busy。
- 恢复的会话里，上一个进程留下的、没有 `session.task_end` 或 `session.task_closed` 的电脑任务，进程一开始就补上（见「电脑任务（H2）」的「重新打开」）。
- 一个任务的 `session.task_end` 或 `session.task_closed` 写不进去时，进程结束它的执行层、放掉锁，然后以退出码 3 退出，下次打开时补上（见「电脑任务（H2）」的「任务的结局写不进去」）。

**历史放在哪：** `<--dir，默认 ~/Library/Application Support/DeskMind>/sessions/<session_id>/session.jsonl`。文件夹权限 0700，文件 0600，只在这台 Mac 上。写法和运行的 `events.jsonl` 一样（`src/protocol/events.ts` 的 EventLog）：每条入库的事件带 `seq`（从 1 起，连续）、`t`（秒）、`session_id`，先写盘、fsync，再发到 stdout。电脑任务的运行目录在同一个文件夹的 `runs/<run_id>/`（执行层的 `--runs`，里面有它自己的 `events.jsonl`、trace 等，另有执行层的 stderr `executor.log`）。整台 Mac 共用的电脑锁在 `sessions/` 下：`computer.guard` 和 `computer.lock`（这台 Mac 一次只跑一个电脑任务，见下面「电脑锁」）。会话不删运行目录。
- **入库：** 用户和助手的最终消息（`session.message`），模型出的错（`session.error` 里的 no_key、key_invalid、network、quota、bad_config），以及 H2 的 `session.task`、`session.task_end`、`session.task_closed`、`session.task_respond`、`session.task_undo`、`session.steer`、`session.retry`，还有设置 `session.config`。
- **不入库（没有 `seq`）：** `session.start`、流式的 `session.delta`、对某一行控制的拒绝（busy、too_long、computer_busy、card_open、no_task、undo_expired、not_idle、bad_control、no_model，以及 `set_config` 的 bad_config）、排队的样子 `session.queue`，以及转发的执行层事件（它们在运行目录的 `events.jsonl` 里，有自己的 `seq`）。
- 进程在回复中途被杀掉：那段回复从没入库，就没了；用户的那条消息已经入库，留着。重新打开后，这条没得到回复的消息和用户的下一条消息在上下文里连成一条（中间空一行），模型看到的仍然是一问一答交替。进程不会自己补答。

**事件（进程 → app）：**

| kind | 字段 | 入库 | 说明 |
|---|---|---|---|
| `session.start` | `session_id, protocol:{session:1}, last_seq, resumed` | 否 | 进程一开始发一次。`protocol` 只报会话接口的版本：执行层的事件照它们自己的版本（`start.protocol`）。`last_seq` 是盘上最后一条的 `seq`，`resumed` 表示这是已有的会话 |
| `session.message` | `msg_id, role: user\|assistant, text, reply_to?, model?, stopped?, truncated?, via?, client_id?` | 是 | 最终消息。`reply_to` 是助手消息回答的那条用户消息；`model` 是 `<服务>\|<模型>`；`stopped: true` 是用户停下了，`text` 是停下时已经说出的部分（可以是空的）；`truncated: true` 是到了 64k 字被截断（或模型自己到了输出上限）；`via` 是用户消息怎么来的：`cua`（`/cua`）、`queue`（任务进行时排队、任务结束后交给模型的）。模型在一次回复里开了电脑任务时，任务之前说的话是一条助手消息，任务之后说的是另一条（新的 `msg_id`，同一个 `reply_to`） |
| `session.delta` | `msg_id, text, offset` | 否 | 流式输出，大约每 50 毫秒合并成一条。`offset` 是这段文字在整条回复里的起点，所以 app 能发现重复和缺口。每次回复先发一条 `text:""、offset:0` 的空 delta，表示「开始回复了」（app 显示「思考中」）；任务结束后模型接着说时，新的 `msg_id` 也先有一条空 delta。同一个 `msg_id` 的所有 delta 按 `offset` 拼起来，就是最后那条 `session.message` 的 `text`：服务最后给的全文和流式发出的对不上时，在最终消息之前再发一条 `offset:0` 的 delta，内容是全文，app 用它整个替换 |
| `session.error` | `code, text, msg_id?, reply_to?, control?, client_id?` | 见上 | `code` 见下表。`msg_id` 是失败的那次回复：它之前发过的 delta 作废，app 把那个正在长的气泡去掉。`reply_to` 是没得到回答的用户消息。`control` 是被拒绝的那行控制的 `type`；`client_id` 是那行带的（见下「client_id」） |
| `session.task` | `msg_id, run_id, raw, goal?, by: slash\|model, reply_to?` | 是 | 一个电脑任务开始了（H2）。`raw` 是交给执行层的用户原话，`goal` 是模型的转述（只有 `by:"model"` 有），`reply_to` 是它在回应的用户消息。之后带这个 `run_id` 的执行层事件都属于它 |
| `session.task_end` | `run_id, status, summary, undo: open\|none, reason?, cause?, answer?, changes?, steers?, undo_until?, result_card?` | 是 | 任务结束了（H2），也就是告诉模型的那些：`status` 是执行层 `task_done` 的 status，或 `interrupted`（进程没了、运行里也没有 task_done）；`cause` 照抄 `task_done.cause`（只认已知的取值，不从 reason 推）；没有 `task_done`、由会话自己记的结局（执行层没写 task_done 就退出了、app 走了而任务没在时限内确认停下、重新打开时发现 `interrupted`），在有一步开始了（`step`）还没有 `step_result` 时是 `last_step_unknown`，否则不带；`cause` 不进模型读到的内容；`changes` 每一类最多 20 个，多出的个数在 `changes.more`；`undo: open` 表示结果卡上的撤回这时可以点；`undo_until`（M2 H2 加的，可选）：`undo: open` 时撤回到什么时候自己结束，照抄执行层的 `task_done.undo_until`（1970 年起的秒），只用来显示还剩多久，能不能点照旧看有没有 `session.task_closed`；`result_card`（M2 H2 加的，可选）：没有 `task_done` 的结局（执行层没写 `task_done` 就退出、app 走了而任务没在时限内确认停下、重新打开时记的 `interrupted`）而这次运行改了东西时，会话照这次运行的日志自己写的结果卡，用的是执行层同一条规则、同一种列法（所以和执行层活着时的卡、以及重启后读同一份日志的结果一致）：第一行「执行进程意外退出，撤不回」（没确认停下的是「任务没有及时确认停下，撤不回」），然后是可能做了的步骤，以及最后一条 `changes` 里的文件；读不到日志时按事件里的 `step_result.possibly_done`（没有这个字段、或者只有 `step` 没有结局的，都算可能做了）；只有「好的」，没有撤回；没有可能做了的步骤、也没有文件改动就没有这一项；`steers` 是用户中途补充、已经交给任务的话 |
| `session.task_closed` | `run_id, why: linger\|new_task\|session_end` | 是 | 这个任务的执行层不在了，结果卡再也答不了（H2）。`linger`：它自己结束了（结果卡答了、等到了时间、或者本来就没有结果卡）；`new_task`：这台 Mac 上开始了新的电脑任务，撤回过期；`session_end`：会话进程结束（或上一个进程没了） |
| `session.task_respond` | `run_id, option, undo` | 是 | 结果卡答了（加的，不升版本）：在把 `respond` 转给执行层之前入库，`undo` 表示选的是结果卡上的撤回。从这条到 `session.task_undo` 之间撤回可能正在做；会话进程中途没了，重新打开时据此补记撤回的结果（见「重新打开」） |
| `session.task_undo` | `run_id, undone, total, refused, unknown?` | 是 | 结果卡的撤回做了（H2）：执行层 `result_response` 里的那三项。`unknown: true`（加的，不升版本）：撤回开始了却被中断、没有 `result_response` 的那种（执行层在撤回途中退出时当场记，在 `task_closed` 之前；会话进程中途没了时，重新打开时补记）——做了多少不知道，`undone`、`total` 这时是 0，`refused` 写原因；模型读到的是 `unknown (…)`，不会当成过期。`session.task_respond`（`undo: true`）之后、`session.task_undo` 之前，模型读到的撤回是 `undoing` |
| `session.steer` | `run_id, text, client_id?` | 是 | 用户在任务进行中补充的话，已经发给执行层（H2）。执行层采用时另发 `steered` |
| `session.retry` | `reply_to` | 是 | 用户要求重答最后一条用户消息（H2）：从上下文里拿掉之前对它的回答 |
| `session.config` | `config, model?, lang, by: set_config\|open, client_id?` | 是 | 会话的设置，从这里起生效（加的，不升版本）：`set_config` 的回答（`by:"set_config"`，带那一行的 `client_id`），或打开时给的设置和存着的不一样（`by:"open"`，见「设置的先后」）。`config` 是配置名或 `openai:<服务>\|<模型>`，`null` 是没有模型；`model` 是它的 goal 模型 `<服务>\|<模型>`（没有模型时不带）。key 只在环境变量里（见「模型和上下文」）；`config` 只能是配置的写法允许的样子，也不能是环境里某个 key 的值（见控制表 `set_config`）。重新打开时不带设置就用最后一条的 |
| `session.duplicate` | `client_id, control, seq` | 否 | 一行 `say`、`cua`、`steer` 带的 `client_id` 已经入库过（`seq` 是那条 `session.message` 或 `session.steer`）：这一行不再执行，这条就是它的回答（见下「client_id」） |
| `session.queue` | `items: [{id, text, held?, note?, client_id?}]` | 否 | 任务进行时打字排队的样子（H2），每次变化都发完整的列表（空的也发）。`held: true` 是任务被停下了、不会自己发出去，`note` 是给用户看的一句话（「任务已停，要发吗？」） |
| 执行层的事件 | 原样，加 `session_id` | 否 | 任务的每一个事件（`start`、`ask`、`step`、`task_done`、`result_response` …，第二节）原样转发，只多一个 `session_id`；它们带自己的 `run_id` 和 `seq` |

`session.error` 的 `code`：

| code | 意思 | 入库 |
|---|---|---|
| `no_key` | 这个配置用的服务没有 key（`text` 写的是缺哪个环境变量，不含 key 本身） | 是 |
| `key_invalid` | 服务拒绝了 key（HTTP 401 / 403） | 是 |
| `quota` | 余额或额度不够、被限流（HTTP 402 / 429） | 是 |
| `network` | 连不上、超时、服务出错（5xx），以及其他没归类的失败 | 是 |
| `bad_config` | 不认识的配置名，配置里不是带 key 的服务，或者服务说没有这个模型（404） | 是。拒绝 `set_config` 的那种（`control:"set_config"`，`text` 从不复述那个配置）否 |
| `busy` | 上一条回复还没完就又来了 `say`、`cua`、`retry`（先 `stop` 或等它说完）；或者会话被另一个进程占着 | 否 |
| `too_long` | 用户消息超过 32k 字（字符数）。这条消息不入库，app 留着输入框里的字 | 否 |
| `computer_busy` | `/cua` 或撤回时电脑正被另一个会话的任务占着（H2）。`/cua` 的话不入库 | 否 |
| `card_open` | 任务在等用户回答卡片时来了 `say`、`steer` 或 `queue_send_now`（H2）。卡片要在卡片上答：app 这时禁用输入框，要打字的卡有自己的输入框（`answer{text}`） | 否 |
| `no_task` | `steer`、`answer`、`respond`、`reask`、`stop{run_id}`、`attach{run_id}` 说的任务不是这个会话的、已经关了，或者没有任务在跑（H2） | 否 |
| `undo_expired` | `respond` 来的时候这台 Mac 上已经开始了别的电脑任务，撤回过期了（H2）。这个任务同时关掉（`task_closed new_task`）。或者（M2 H2）撤回来的时候已经过了 `task_end.undo_until`（按墙上时钟）：会话自己拒，不转给执行层、不记 `task_respond` | 否 |
| `not_idle` | `end_if_idle` 来的时候会话不是闲着的（见控制表）：多带一个 `why`，列出 `busy`、`queue`、`task`、`recovering` 里成立的几条。会话照旧，什么都没动 | 否 |
| `bad_control` | 控制行缺它要的东西（H2）：`respond` 没有 `option`，或者它不是结果卡上某个选项的下标（整数）。什么都不占、不转发，之后合格的 `respond` 照常 | 否 |
| `no_model` | 会话没有模型（`set_config{config:null}`）时来了要用模型的控制：`say`、`cua`、`retry`、`steer`、`queue_send_now`（加的，不升版本）。**不管会话这时在做什么**（任务正在停下、重新打开的补记还没写完、有回复在收尾）都立刻回这个，从不排队——否则排进去的话没有任何控制能发出去（`queue_send_now` 也是 `no_model`），`end_if_idle` 会一直说 `queue`。这一行什么都不做、不入库；之前已经排着的话还在排队。重复的 `client_id` 照旧回 `session.duplicate`。另一种：回复的这一轮在请求发出去之前发现模型被关了，这一轮不发，回一条带 `msg_id`、`reply_to` 的 `no_model`（不入库），app 把那个气泡去掉；用户那条消息已经入库 | 否 |
| `not_yet` | H1 用过（H2 的控制还没做时），现在不再发 | 否 |

前五个出现时，用户那条消息已经入库了（`reply_to` 指向它）。错误的 `text` 最多 300 字，而且去掉了 key：环境变量里各家服务 key 的实际值（服务可能把收到的 key 原样写进错误里），以及看起来像 key 的 `sk-…`、`Bearer …`。`model-check` 用的是同一个函数（`src/gateway/index.ts` 的 `redactKeys`）。

**控制（app → 进程）：**

| type | 内容 | 说明 |
|---|---|---|
| `say` | `{"type":"say","text":"…","client_id"?:"…"}` | 用户发一条消息：先入库，再开始回复。一次只回复一条。有任务在跑时不入库，进排队（见下）；有卡片在等时拒绝（`card_open`） |
| `stop` | `{"type":"stop","run_id"?:"…","client_id"?:"…"}` | 带 `client_id`（一条 cua 的）：见下「stop{client_id}」。带 `run_id`：转给那个任务的执行层（在跑的停下；还在等结果卡的，结果卡放下：会话先把这张卡记成「已关（停下）」再转，之后的 `respond` 由会话直接拒（`undo_expired`），不记 `task_respond`、也不会记成撤回被截断；撤回已经在做时 stop 不打断它）。不带：有任务在跑就停那个任务，否则停下正在进行的回复——已经说出的部分作为 `stopped: true` 的消息入库；没有回复在进行时什么也不做。模型已经说完、只是结果还没处理时到的 stop 不算，那条消息照常入库，不带 `stopped` |
| `attach` | `{"type":"attach","after_seq":n,"run_id"?:"…"}` | 补发：把 `seq` 大于 n 的入库事件按顺序重发一遍（不重复、不跳号）。如果正有回复在进行，再发一条 `offset:0` 的 delta，内容是到现在为止说出的全部文字，之后的 delta 接着这个 offset 往下；最后总发一条 `session.queue`（空的也发：它是完整的排队，app 用它整个替换自己手上的，重连期间排队已经交给模型的，app 就不会还留着）。带 `run_id`（H2）：改为从那个任务的 `events.jsonl` 补发它 `seq` 大于 n 的事件（带 `session_id`） |
| `end` | `{"type":"end"}` | 结束：有任务在跑就先停它（同 stdin 关闭，见下），停下正在进行的回复（同 `stop`，部分入库），然后退出。重新打开时还在等旧执行层的补记（见「重新打开」）先写完再退出，不会丢下没写的结局 |
| `end_if_idle` | `{"type":"end_if_idle","client_id"?:"…"}` | 闲着才结束（加的，不升版本）：处理到这一行的那一刻会话是闲着的，就和 `end` 完全一样地结束（进程退出就是回答）；不是闲着的，什么都不动，回一条不入库的 `session.error{code:"not_idle", control:"end_if_idle", why:[…], client_id?}`。闲着 = 下面四条都不成立，`why` 按这个顺序列出成立的那几条：`busy` 有回复在进行（包括 `/cua` 的任务和它之后的那一轮回复）；`queue` 排队里有话（包括任务停下后 `held` 的）；`task` 有任务还没关（在跑、有卡片在等、结果卡还能撤回、执行层正在自己退出——还没有 `session.task_closed` 的）；`recovering` 重新打开时的补记还没写完（正在等旧执行层，最多 12 秒；或者旧执行层的撤回过了这 12 秒还在做、会话还看着它）。app 只看 `code` 和 `why`，不读 `text`。**顺序保证：** stdin 的控制行严格按顺序处理，一行处理完才处理下一行，而且 `say`、`cua`、`retry`、`queue_send_now` 处理完时它们开始的事已经算在上面四条里了（回复已经开始、任务已经开始、话已经排上）。所以写在 `say` / `cua` 之后的 `end_if_idle` 一定看到那件事、回 `not_idle`，没有「已经发了、还没开始」的空档；没被接受的（被拒绝的 `say`，或者模型没 key 而入库了错误的）本来就没有事在做。会话已经在结束（之前来过 `end`、stdin 关了）时：还有事在等就同样回 `not_idle`，没有了就不回（进程随后退出） |
| `cua` | `{"type":"cua","text":"…","scope"?:"…","client_id"?:"…"}` | `/cua`（H2）：不经过模型，直接开电脑任务，`raw` 就是 `text`。`scope` 是这一次的任务目录（不给就用头一行的）。有回复或任务在跑时 `busy` |
| `steer` | `{"type":"steer","text":"…","run_id"?:"…","client_id"?:"…"}` | 任务进行中补充要求（H2）：原样转给执行层（控制第 1 版的 steer，执行层的规则照旧：两步之间生效，生效时发 `steered`），同时入库 `session.steer` |
| `answer` | 执行层的 answer 行，加 `run_id` | 回答卡片（H2）：整行原样转给那个任务（不带 `run_id` 就是正在跑的那个）；多出来的字段执行层不看。按选项下标答：`{"type":"answer","run_id":"…","ask_id":"…","option":n}`；卡上自己写：`…,"text":"…"}` |
| `reask` | `{"type":"reask","run_id"?:"…"}` | 「现在回答」（M2 加的，不升版本）：转给那个还在跑的任务（不带 `run_id` 就是正在跑的那个），执行层把过期的动作卡重新问一次（见第二节「卡片过期」）。任务已经结束：`no_task` |
| `respond` | 执行层的 respond 行，加 `run_id` | 回答结果卡（撤回等，H2）：转给那个还在等结果卡的执行层（不带 `run_id` 就是最近的一个）。先检查 `option` 是结果卡上的一个下标，不是就 `bad_control`；撤回要动电脑：只有锁里正是这个任务、状态 `lingering` 时才转过去，锁改回 `acting`，到它的 `result_response` 再改回 `lingering`；已经开始过别的任务（锁里不是它了）时 `undo_expired`；同一张卡第二次回答、或锁文件读写出错时 `busy`（带原因）。转过去之前先入库 `session.task_respond`；写不进去就不转，锁改回 `lingering`，回 `busy`（带原因），结果卡还能答。锁也改不回去时，锁会一直说 `acting`，可执行层根本没收到回答，没有 `result_response` 来把它改回去，电脑要被占到 600 秒的等待结束：这和结局写不进去一样，会话进程按「任务的结局写不进去」停下（结束那个执行层，按 compare-and-set 删锁，退出码 3）；历史里没有这次回答，下次打开不记任何撤回 |
| `retry` | `{"type":"retry"}` | 重答最后一条用户消息（H2）：不再存一遍这条消息，入库 `session.retry`，之前对它的回答从上下文里拿掉（其间做过的电脑任务留着：它们真的发生了），然后回复。有回复或任务在跑时 `busy` |
| `queue_edit` | `{"type":"queue_edit","id":"…","text":"…"}` | 改一条排队的话（H2） |
| `queue_cancel` | `{"type":"queue_cancel","id":"…"}` | 撤掉一条排队的话（H2） |
| `queue_send_now` | `{"type":"queue_send_now","id":"…"}` | 立刻发一条排队的话（H2）：有任务在跑就作为 `steer` 发给任务（有卡片在等时 `card_open`）；没有任务就作为 `say` 发给模型 |
| `set_config` | `{"type":"set_config","config":"…"\|null,"lang"?:"zh"\|"en","client_id"?:"…"}` | 不重启进程，改会话的模型配置和语言（加的，不升版本）。`config` 必须有：和头一行的 `config` 是同一种值，或者 `null`（没有模型）。**配置的写法**（头一行、`--config` 同样）只有两种，一字不差：一个配置名（`src/gateway/index.ts` 的 `CONFIGS`，如 `ds-flash`），或 `openai:<服务>\|<模型>`，服务是 `PROVIDERS` 里的一家（`yy`、`openrouter`、`deepseek`、`volcengine`、`custom`、`local`），模型名只能有字母、数字和 `. _ - : / @ +`，字母、数字或 `@` 开头（Cloudflare 的 `@cf/meta/…`），最长 128 个字（所以网址、`?api_key=…`、中间的空格、`=` 都进不来）；模型名前后的空白先去掉再检查、再用、再入库（设置里粘贴的模型名常带着空格）。另外，它不能含环境变量里某个 key 的值（各家服务的 key 变量和名字以 `_API_KEY`、`_TOKEN`、`_SECRET` 结尾的变量，只比 12 个字符及以上的值：`custom`、`openai` 这样的占位值不比，否则会挡掉所有提到它的配置）：整个模型名不能等于一个 key 的值，把配置在 `A-Za-z0-9._-` 以外的字符处切开后，也没有哪一段整段等于一个 key 的值（含 `/`、`+` 的 key，比如 `bce-v3/ALTAK-…/…`、base64，靠的是整个模型名的比较；`LOCAL_API_KEY=qwen30-local-key` 挡 `openai:local\|qwen30-local-key`，不挡 `openai:local\|qwen30-local-key-v2`）。这是写法检查，不是 key 识别：一个本身就是 key、又不在这个进程环境里（或者只是 key 的一部分）的模型名，分辨不出来。`model-check`（app 的「测试」按钮）用同一个检查，所以测试通过的配置会话也收。配置还要能用（服务需要的地址有着落、是带 key 的服务）；key 不检查：key 照旧从进程的环境变量来，`set_config` 不带 key，所以换到一个启动时环境里没有它的 key 的服务，下一轮是 `no_key`（要新 key 生效仍然要新进程）。不合格的、`lang` 不是 zh / en：回 `bad_config`（`control:"set_config"`，不入库，`text` 不复述配置），什么都不变。合格的：先生效，再入库 `session.config` 作为回答（写不进去时照样生效，另回一条 `busy` 说明没存上，app 应当当它没存：重新打开会用之前存的）。**按 stdin 的顺序生效：** 不是 `null` 的配置，这一行之后要发出请求的每一轮模型调用都用它（包括同一次回复里任务结束后的下一轮）；已经发出请求、正在流式输出的那一轮用旧的说完。`lang` 管这之后说出来的一切：下一次回复的系统提示和工具说明、会话自己的拒绝文字、之后开始的任务的请求。不是 `null` 的 `config` 不重启、不停任何东西：正在跑的任务用它开始时的配置做完，新的从下一个任务起。**`null`（没有模型）：** 再也不发起任何一轮模型调用，也不再往外发已经发起的：正在进行的回复按 `stop` 停下（已经说出的部分入库，`stopped: true`）——包括服务出错后在等重试的那一次（429、5xx 后服务端要求的等待，重试不会再经过「这一轮用哪个模型」的检查，不停下就会把整段对话再发一遍）；`say`、`cua`、`retry`、`steer`、`queue_send_now` 立刻回 `no_model`（见错误码表）；任务结束后本来要接着说的那一轮（模型的 `computer_task` 返回之后、`/cua` 之后的那一轮）不跑，任务的结局照常入库，以后有模型时下一轮能看到；停下的那一轮要开的 `computer_task` 不开；排着的话留在排队里，不交给模型。正在跑的电脑任务按普通的 `stop` 停下（`cause: user_stopped`），排着的话照停下的规矩标成 `held`；它正在做的那一步也不再问任何判官：执行层的每个判官问题（意图、会不会发出去、出处、计划的依据、结束时的核对）和改写都在发出前看停止信号，已经发出的被它中止（见第三节 `stop`）。不需要模型的照常：结果卡的 `respond`（撤回只用执行层的回执）、卡片的 `answer`、`stop`、`queue_edit` / `queue_cancel`、`attach`、`end`。**之后再来一条不是 `null` 的 `set_config`，一切恢复：没有 `held` 的排队话会自动交给模型**（app 要是不想这样，在打开模型之前先 `queue_cancel` 它们）；`held` 的照旧等用户 |

别的 `type`、不是 JSON 的行、没有 `type` 的对象一律忽略（兼容规则同第四节）。

**模型和上下文：**
- 用配置里 `goal` 角色的模型，经 pi-agent-core 的 `runAgentLoop` 调，流式收 `text_delta`。用哪个配置在每一轮发请求之前现取（`set_config` 改了就用新的，见控制表）；这一轮的服务、key、DeepSeek 的补丁都跟着这一轮的模型走，`model_calls.jsonl` 每行的 `model` 是那一轮的模型，助手消息的 `model` 是说这条话的那一轮的。工具只有一个 `computer_task({goal})`（声明在开头的系统消息上，所以服务的提示缓存不受影响）。key 和服务地址从环境变量来（和 `app-run` 一样）：配置里只有服务名和模型名，从来没有 key；`session.jsonl`、`model_calls.jsonl`、事件里都不会出现 key（出错的文字也去掉了 key，见上）。
- 系统提示：DeskMind 是用户 Mac 上的个人助手（末尾写着今天的本地日期）；它只能通过 `computer_task` 操作电脑；goal 写它的转述，用户原话会原样交给任务；改用户东西、往外发之前任务自己会出卡征得同意，不用先问；一条用户消息最多开 3 个任务；它看不到屏幕和文件，只看得到任务的结果；**只有 status 是 succeeded 才能说做成了**，其他状态如实说；不调 `computer_task` 时不能说自己在电脑上做了什么。`lang` 决定系统提示用中文还是英文。
- 上下文 = 系统提示 + 入库的消息 + 电脑任务。每个任务在上下文里是模型的一次 `computer_task` 调用（`goal`；`/cua` 的是用户的原话）加上它的结果（`session.task_end` 的那些字段，撤回后来做了写成 `undone n/m`，过期了写成 `expired`），结果紧跟在调用后面。还在跑、没有结果的调用不放进去。超过模型窗口的 60%（按一个字算一个 token）时，从最早的开始整轮丢掉（一轮 = 用户的话和对它的回复，包括其间的任务），一次丢到这个额度的一半左右，系统提示末尾加一句「更早的 n 条对话已省略」（n 是丢掉的条数）。这样丢的位置隔好几轮才动一次，模型读到的开头在这几轮里不变，服务的提示缓存用得上。丢到哪里是把对话一轮一轮重放算出来的（每轮的长度只算一次），同样的历史总得到同样的结果。最新的那一轮（含最新的用户消息）永远不丢。停下前一个字都没说的回复不进上下文；说了一半的进上下文，并注明「这条回复被用户中途停下了」。
- DeepSeek 在思考模式下，送回去的带工具调用的助手消息必须有 `reasoning_content`，否则回 400。从历史重建的调用（以及 `/cua` 代表的那次调用）没有，会话给它一个空的 `reasoning_content`（服务接受）；这次回复里模型自己的调用带着它自己的。只对 DeepSeek 这样做：服务是 DeepSeek 自己的，或者模型名里有 deepseek（经代理的）。
- 一条回复最多 64k 字，到了就截断并停止生成，入库时带 `truncated: true`。
- 每次模型调用记一行到同一个文件夹的 `model_calls.jsonl`（权限 0600），格式和运行的一样，`role` 是 `session`：`tokens_in`（模型读的全部输入，含提示缓存的部分，那部分另记在 `cache_read`）、`tokens_out`、`cost_usd`（服务没给就按价目表算）、`latency_ms`、`sent_chars`、`outcome`，以及 `msg_id`、`reply_to`。开了任务的回复有两次以上调用（每轮一次），各记一行。

**电脑任务（H2）：**
- **开始：** 模型调 `computer_task({goal})`，或用户发 `cua`。会话按「电脑锁」拿这台 Mac：一步之内启动 `harness.mjs executor --linger 600 --runs sessions/<sid>/runs`（自己一个进程组）并把它写进锁；然后这个会话里还在等结果卡的执行层关掉（`task_closed new_task`），入库 `session.task`，最后才把请求 `{run_id, raw, context?, config, lang, driver?, scope?}` 发给执行层（它的第一行 stdin；之前它只是等着，不动电脑）。执行层就是 P2 的执行层，没有改。
- **`raw` 和 `context`：** `raw` 是从上一个任务开始以来用户自己发的消息，原样，用空行连起来，大约最多 4000 字。超了：最新的一条整条留着，前面的从近到远放得下几条放几条，放不下的写「（更早的 n 条消息省略）」；最新的一条自己就超过 4000 字时，留开头 1500 字和结尾，中间写「…（中间省略 N 字）…」——指令通常在开头，不能被截掉、只剩贴进来的正文当成「用户的话」。同一次回复里的第二、第三个任务用同一个 `raw`。模型的 `goal` 只进 `context`（见第三节）。`/cua` 的 `raw` 就是它的 `text`，没有 `context`。
- **模型在等：** `computer_task` 一直挂着，直到任务结束，所以任务进行时模型不跑。结束后工具返回 `session.task_end` 的那些字段（JSON），模型接着说。它看不到截图、观察和 trace。一条用户消息最多 3 个任务，第 4 个直接回错误给模型。**用户停下了一个任务**（status `stopped`）之后，这次回复不能再开任务（不管模型读到的网页里写了什么）：模型再调就回错误，它说完下一轮就结束这次回复。
- **拿锁之后出错（比如磁盘满了）：** 拿锁、启动执行层、关掉之前的结果卡（`task_closed new_task` 写不进去）、入库 `session.task`，这一路上任何一步出错，这次开始就作废，把它拿到的都放掉：执行层还没收到请求，直接 SIGKILL 它的整个进程组；锁只在还正是这次写的那个占用者（同一任务、进程组、状态、`gen`）时删掉，变过了就不碰；组结束不了时锁照旧（`acting`），2 秒后再结束它。任务不开始，什么都不记成开始了（`session.jsonl` 的每一条都是要么整条写进去、要么不留：写到一半或写进去了却同步不了，就截回去，所以报了失败的不会其实已经在文件里；连截回去也失败时，下一条另起一行、用同一个 `seq`，读的时候同一个 `seq` 以后写的为准；这样失败的一条正好是进程退出前最后一条时，重新打开会把它读进来——要两次磁盘出错再加退出，不专门防）：`/cua` 回 `busy`，带原因（`/cua` 的话已经入库的，拒绝不再带 `client_id`）；模型的工具返回错误「任务没能开始（电脑上什么都没做）：<原因>」，这次也算进这条消息的任务数。之前的结果卡照样都关掉（锁已经结束了 `lingering` 的那个；锁自己写失败时，已经被结束的那个也记 `new_task`）；其中哪条 `task_closed` 写不进去，会话进程就停下（见下一条「任务的结局写不进去」）。`attach{run_id}` 补发的是执行层自己记的事件，`task_done` 里带着原来的 `result_card`：结果卡还能不能答，看会话的 `session.task_closed`（以及 `session.task_end` 的 `undo`），不看补发的卡。唯一的例外：`session.task` 已经入库、请求却发不出去时，任务算开始了，同样结束它的进程组、放掉锁，它的结局记 `failed`，原因写「the task could not be sent to the executor: …」。
- **任务的结局写不进去（比如磁盘满了）：会话进程停下，非零退出。** app 只从 `task_done`、`session.task_end`、`session.task_closed` 和会话进程退出（helper 的 `helper.session_exit`）知道一个任务结束了、结果卡不能再答；所以一条 `session.task_end` 或 `session.task_closed` 写不进去时，会话不能当它写进去了接着跑（以前是这样：app 上的撤回一直能点、任务一直显示在做，而重放里也没有这条，补不回来）。不分是哪条路上写的——执行层说 `task_done`、执行层退出、新任务关掉之前的结果卡、撤回过期、执行层自己结束（linger）、app 走了停任务、退出时关掉执行层、重新打开时补记——都一样：先把这个会话的每个执行层的 stdin 关掉，让它把手上的事做完再结束：闲着等结果卡的读到 stdin 结束就退出；正在撤回的（`respond` 转过去了）做完撤回、写了 `result_response` 才退出——这时不给它发信号，因为说过 `task_done` 的执行层收到信号会立刻退出，撤回就断在半路；还没说 `task_done` 的（任务还在做），另给它本身（不是整个进程组，和「重新打开」一样）发 SIGTERM，走它自己的停下（最多等 0.8 秒加正在驱动那里的动作的回执 10 秒，写 `task_done`；驱动的子进程由它自己收尾）。最多等停下的时限（和 app 走了时等停下一样，12 秒），过了时限组里还剩的才结束（整个组 SIGTERM，最多 1.5 秒，再 SIGKILL），确认组没了；锁只在还正是这个会话给这个任务写的那个（同一任务、进程组、状态、`gen`；或者至少同一任务、进程组且组里没人了）时删掉，已经是别人的就不碰，组结束不了就照旧占着；重新打开时正在结束的旧执行层也等它结束。正在说的回复停下，什么都不再入库，执行层后来的事件不再转发，之后的控制行不再处理（引起这次停下的那一行照常得到回答，比如 `/cua` 的 `busy`、`respond` 的 `undo_expired`）；排队的话不发给模型——它们本来也写不进去，最后发的 `session.queue` 就是它们的去处，和进程正常退出时一样。然后进程退出，退出码 3，stderr 写「session: stopping: <哪条记录> of <run_id> could not be stored: <原因>; the next open records what is missing」。helper 照常发 `helper.session_exit`。下次打开时「重新打开」补上缺的：没有 `session.task_end` 的补一条（运行里有 `task_done` 就照它，`undo: none`；没有就 `interrupted`），撤回开始了（`session.task_respond` 的 `undo`）却没有 `session.task_undo` 的补一条（运行里有 `result_response` 就照它记做了几步；没有，就是撤回被时限截断了，记 `unknown`——从来不悄悄变成过期），没有 `session.task_closed` 的补 `session_end`——包括结局写进去了（可能是 `undo: open`）、关闭没写进去的那种：补上 `task_closed` 后撤回就过期了（新进程里没有这个执行层，`respond` 回 `no_task`，模型读到的是 `expired`），不会把一个执行层已经不在的撤回又亮出来。补记还是写不进去，就同样停下，下次再补。结局、关闭和撤回的结果（`session.task_undo`：撤回动了用户的东西，不能在下次打开之前一直被读成「过期」），还有 `respond` 的回答没入库、锁又改不回 `lingering` 的那种（见控制表 `respond`），这样处理：`session.task_undo` 写不进去时锁照样先改回 `lingering`，然后会话停下，下次打开时照运行里的 `result_response` 补上；开始一个任务时写不进去的按上一条作废这次开始。
- **记不下来的其他地方：** `task_done` 时锁改不成 `lingering`：这个任务不再等结果卡（`undo: none`，转出去的 `task_done` 照旧带着结果卡（M2 H2：改了东西就有结果卡），但不带 `undo_until`；关掉它的 stdin，它退出，锁随之放掉），免得 `acting` 的锁占着电脑 600 秒。`result_response` 时先把锁改回 `lingering`，再记 `session.task_undo`（锁照样先改好；这条写不进去，会话就按「任务的结局写不进去」停下）。
- **`/cua` 之后：** 任务结束，模型说一轮：它的上下文里这个任务是一次 `computer_task` 调用和结果，用户消息是 `/cua` 的原话（`via: "cua"`）。这一轮不能再开任务。
- **电脑被占：** 另一个会话的任务正占着锁时，模型的工具返回「电脑正被另一个会话使用，等它做完再试。」，`/cua` 回 `session.error{code:"computer_busy"}`。
- **转发：** 执行层的每个事件原样发到会话的 stdout，加上 `session_id`。`answer`、`respond`、`reask`、`stop`（带 `run_id`）和 `steer` 转到那个执行层的 stdin（控制第 1 版的行，多的字段执行层不看）。
- **stop{client_id}（加的可选字段，不升版本）：** `stop` 可以带一条 `cua` 自己的 `client_id`（代替 `run_id`）：app 还没看到 `session.task`、不知道 `run_id` 时，也能停下那条 /cua 开的任务，而且由会话确认，不靠 app 本地超时。会话按记录找：那条 /cua 开任务时，`session.task` 上记着它的 `client_id`（加的可选字段），只按这个字段找；重试或模型后来为同一条消息开的任务不带它，不会被停。每一行 `stop{client_id}` 都有且只有一条 `session.stop_ack{client_id, result, run_id?, status?}`（不入库）：
  - 没有从这条 /cua 开出的任务（/cua 还没到——stop 超车了——或者被拒了）：什么都不停，入库一条 `session.cua_cancelled{client_id}`，之后带这个 `client_id` 的 `cua` 一律拒（`cancelled`），重新打开后也一样；`result: "none"`。
  - 任务还在跑：和 `stop{run_id}` 一样停下它；等它的 `session.task_end` 入库后才回 `result: "stopped"`，带 `run_id` 和 `status`（它实际怎么结束的；停之前已经做完的照实说）。不管 `task_end` 是哪条路记的（执行层的 `task_done`、执行层没写 `task_done` 就退出、app 走了而任务没在时限内确认停下、重新打开时补记的 `interrupted`）都会回；会话因为写不进历史而停下时，按 `interrupted` 回。
  - 任务已经结束：没有可停的，任务和它的结果卡都不动（结果卡还开着的照样能撤回——app 收尾时发的、或者任务刚做完时按的停止，不会把撤回弄没）；`result: "already_ended"`，带 `run_id`、`status`。`stop{run_id}` 不变：仍然会关掉还开着的结果卡；同时带 `run_id` 时，`run_id` 那部分照旧这样处理。
  - 同一个 `client_id` 再停一次：同样的回答；重新打开会话之后，按历史回 `already_ended`，带同样的 `run_id` 和 `status`（第一次回的若是 `stopped`，也是这样，不另存）。
  - `session.cua_cancelled` 写不进去：会话按「任务的结局写不进去」停下，这一行照样回一条 `stop_ack{result:"none", status:"interrupted"}`（取消没有记下来）。
  - `client_id` 只认一条 `cua` 的 id；给别的 id（比如一条 `say` 的）找不到任务，回 `none`，什么都不停。
  - 同时带 `run_id`：先照普通的 `stop{run_id}` 处理那个任务，再回 `client_id` 的那一部分（之前回过的照旧回）。
- **req_id（加的可选字段，不升版本）：** `answer` 和 `respond` 可以带 app 给这一次请求起的 id（字符串，最长 100 个字符，更长的当没有）。会话拒绝这一行时，`session.error` 带回 `control`、它针对的任务 `run_id`（知道的话）和同一个 `req_id`——每一种拒绝都是（`no_task`、`bad_control`、`busy`、`undo_expired`……）；收下的 `respond` 入库的 `session.task_respond` 也带着这个 `req_id`。小助手会把拒绝发给所有看着的人，所以 app 按 id 对上自己发出的请求，不按先后。不带 `req_id` 的行和以前完全一样（拒绝里没有 `run_id` / `req_id`）。执行层自己对回答的拒绝（`refused` 事件）不带它。
- **client_id（加的可选字段，不升版本）：** `say`、`cua`、`steer` 可以带 app 自己给这段话起的 id（字符串，最长 100 个字符，更长的当没有）。会话把它原样带回到这段话的结局上：入库的用户消息（`session.message`，包括排队后按 `via: "queue"` 入库的）或 `session.steer`、它排着的那条 `session.queue` 项（`queue_send_now` 发出时也带着）、拒绝这一行的 `session.error`（busy、too_long、card_open、computer_busy、no_task；`end_if_idle` 也可以带 `client_id`，它的 not_idle 带回来），以及重发时的 `session.duplicate`（见下）。app 据此知道自己的话落到了哪里：小助手回的 ok 只说明这一行写进去了，不说明会话收下了。几处细节：`queue_send_now` 被拒（`control: "queue_send_now"`，带那一项的 `client_id`）时，那一项照旧在排队里，话的主人还是排队；会话正在结束时，`queue_send_now` 被拒（busy），那一项留在排队里，而 `say`、`cua`、`steer` 不回任何东西（进程随后退出）；`text` 是空的或只有空白的 `say`、`cua`、`steer` 也不回任何东西（app 不该发这样的）；`client_id` 是空字符串也当没有。进程退出时还在排队的话不会入库，也不会再有事件提到它们：它最后发的 `session.queue` 就是它们最后的去处，app 把它们当成没发出去（重连后 attach 发的是新进程的排队，通常是空的）。
- **按 client_id 只做一次（加的，不升版本）：** 会话记得收下过的 `client_id`（入库的用户消息和 `session.steer` 上的；进程启动时从 `session.jsonl` 读回，所以换了进程也算）。同一个 `client_id` 的 `say`、`cua`、`steer` 再来（app 没收到上次的结局又发了一次）：已经入库的，不再执行，回一条 `session.duplicate`（带那条入库事件的 `seq`）；还在排队里的，不再排一次，回一条当前的 `session.queue`。所以重发不会存两次，也不会开两个任务。被拒绝过的、被 `queue_cancel` 撤掉的、进程退出时还在排队没入库的，不算收下：再发照常处理。一个例外：`/cua` 的用户消息入库之后、任务没能记下（写盘失败）而被拒（busy，不带 `client_id`）的，消息已经入库，算收下：再发回 `session.duplicate`。因此 `client_id` 在一个会话的整个生命里（跨 app 的重启）都要唯一，比如用 UUID；重复用的 id 会被当成重发。
- **任务进行时打字：** `say` 排进队（`session.queue`，每次都发完整列表），可以 `queue_edit`、`queue_cancel`、`queue_send_now`（有任务时等于 steer）。`steer` 直接转给执行层。任务结束、模型说完之后，排队的话按顺序作为用户消息（`via: "queue"`）入库，模型对它们回一次；任务是被停下的（status `stopped`），就不自动发，每条标上「任务已停，要发吗？」（`held: true`），等用户 `queue_send_now` 或撤掉。
- **卡片在等时（负责人 10-21）：** app 禁用输入框（同 Claude Code）；要打字的卡有自己的输入框，用 `answer{text}` 答。所以任务里有卡在等（`ask` 之后还没有同一 `ask_id` 的 `resumed` / `ask_void`）时，`say`、`steer`、`queue_send_now` 回 `card_open`。动作卡过期（`ask_void{why:"timeout"}`）之后没有卡在等：打字照常排队，`steer` 照常转给任务（M2 H1）。
- **结果卡的状态只在会话里定（M2 H2）：** 每个任务的结果卡是 `open`（能答）→ `undoing`（撤回已收下、记了 `task_respond`、转给了执行层）或 `closed`（停下、过期、答过、执行层没了）。`respond` 只在 `open` 时收下；`stop` 让 `open` 立刻变成 `closed`，再转给执行层；`undoing` 时来的 `stop` 照转，但撤回不会做到一半就断。执行层只收到这个状态放过去的行，它 stdin 上的顺序就是这些转换的顺序。`session.task_undo{unknown:true}` 只在卡到过 `undoing`、执行层却没写 `result_response` 就退出时才记；执行层按过期拒掉的撤回记成 `task_undo{undone:0, refused:"expired"}`；执行层写过 `result_card_closed`、却没有 `result_response` 就退出的（撤回在宽限期之后才到），同样记成过期（那张卡在截止时没有撤回在做，什么都没撤），重新打开时补记也一样。
- **撤回和等待（负责人 10-21）：** `task_done` 之后执行层最多再等 600 秒结果卡（`--linger 600`，按墙上时钟，到 `undo_until`）。不管任务怎么结束，有结果卡就等（M2 H2：停下、失败的任务改了东西，也能撤回）。会话在把 `task_done` 转出去**之前**把锁改成 `lingering`（app 一看到结果卡就点撤回也能过）。`respond` 见上表。这台 Mac 上开始**任何**新的电脑任务，撤回就过期：新任务拿锁时结束那个 `lingering` 的进程组；它所在的会话看到执行层退出、锁里已是别的任务，发 `task_closed new_task`。执行层自己结束（答了结果卡、到了时间、本来没有结果卡）时发 `task_closed linger`。
- **app 走了（stdin 关闭，负责人 10-21）：** 有任务在跑就给它发 stop（带 `app_gone: true`），最多等 12 秒它的 `task_done`。等到了就按它的结局记 `session.task_end`（通常是 `stopped`）；等不到就记 `status: "stopped"`、reason「the app went away; the task did not confirm the stop in time」（有一步开始了还没结局时带 `cause: "last_step_unknown"`），这时执行层可能还在收尾，锁留给它（锁写的是它的进程组，和会话进程在不在无关），整个组都退出后别人才能接过来。然后关掉所有执行层（`task_closed session_end`），不再让模型说话，退出。`end` 和 SIGINT / SIGTERM 一样。
- **重新打开时模型等补记写完：** 补记还在等旧执行层（最多 12 秒）时，模型不说话、不读一半的历史：`say` 的话进排队（`session.queue`，带 `client_id`），补记写完后按排队入库（`via: "queue"`）、交给模型；`cua`、`retry`、`queue_send_now` 回 `busy`，带 `why: ["recovering"]`（不是「上一条回复还没完」）。旧执行层的撤回过了这 12 秒还在做，不打断它，也不再挡着模型：之后一直看着它，它写出 `result_response` 或进程组没了，就照运行记录补 `session.task_undo`（有结果照结果，没有才 `unknown`），再补 `task_closed`；在那之前这个进程退出了，就留给下次打开。这时模型读到的这个任务的撤回是 `undoing`（撤回正在做：不是还能点的 `open`，也不是过期，更不说结果），会话也不算闲着（`end_if_idle` 回 `recovering`）。
- **重新打开：** 有 `session.task` 没有 `session.task_end` 的任务，读它的 `runs/<run_id>/events.jsonl`：有 `task_done` 就照它补一条 `session.task_end`（`undo: none`：执行层已经不在了），`steers` 取自其中的 `steered`，`cause` 照抄；没有就记 `interrupted`（带运行记录里最后一条 `changes` 事件的改动，和照 `task_done` 记时带它的改动一样，模型重新打开后照样看得到这个任务改了什么；会话自己记的、没有 `task_done` 的结局——执行层没说 `task_done` 就退出、app 走了而停不下来——同样带上最后一条 `changes`；运行记录里有一步只有 `step`、没有 `step_result` 时带 `cause: "last_step_unknown"`）。如果锁里写着这个任务、它的进程组还活着：先给执行层本身（不是整个组）发 SIGTERM，最多等 12 秒它自己的 `task_done`（有就照它记，带它的改动），等不到才记 `interrupted`，同时结束这个组里还剩的进程。有 `session.task_respond`（`undo: true`）没有 `session.task_undo` 的任务：执行层还在（撤回正在做）就不发信号，最多等 12 秒它的 `result_response`；等不到也不结束它，而是接着看着它（见上一条），撤回做完或组没了再补；然后照运行里的 `result_response` 补一条 `session.task_undo`，没有就记 `unknown: true`。补记前先看历史里有没有这条，不会记两次。没有 `session.task_closed` 的任务补一条 `session_end`。这几条按结局、撤回、关闭的顺序补，哪条写不进去就停下（见「任务的结局写不进去」）。

**电脑锁（第 2 版，会话和 DeskMind helper 共用；`src/session/computer.ts`，helper 里 `ComputerLock` 是同一协议的 Swift 版）：**
- **两个文件**，都在 `<--dir>/sessions/` 下：`computer.guard`（空文件，只用来加 flock：读改写锁的每一步都在这个排他锁里做，进程之间不会交错；Node 用 macOS 的 `O_EXLOCK` 打开它）；`computer.lock`（占着的人，JSON，整个文件换掉：先写自己的临时文件再 rename 过去）：
  `{"v":2, "state":"acting"|"lingering", "pgid":N, "pid":N, "start":S, "run_id":"…", "session_id":"…", "by":"session"|"helper"|"hands", "owner":P, "t":T, "orphan_since"?:T, "gen":G}`
- **占着的是能动电脑的那棵进程树：** 执行层作为一个进程组的组长启动（`pgid` = 它的 pid），它启动的都在这个组里。组里还有任何一个（不算僵尸）进程活着，锁就算占着——不管启动它的会话或 helper（`owner`）还在不在。`start` 是组长的启动时间（1970 年起的秒）：组长的 pid 活着但启动时间对不上，说明这个号已经是别人的了，算没人占。`pgid: 0` 表示还没有执行层的进程组：测试里执行层跑在 owner 进程里面；helper 的「预占」（见下）。owner 活着就算占着，是 `acting`，不会被当成没人管的占用。
- **guard 关不上：** 改锁的那一步做完了、关 `computer.guard` 时出错：改动已经生效（flock 随文件关闭放掉），按做成了算（`GuardClosed` 带着结果，会话照它继续：撤回照常转给执行层），不当成没做——否则锁会说 `acting`、却没有执行层收到回答，电脑被占到 600 秒的等待结束。只有拿锁（新任务）例外：这次开始照「拿锁之后出错」作废，锁里是它就删掉。
- **拿锁（新任务）：** 在 guard 里一步做完：锁里是 `acting` 且占着 → `computer_busy`；是 `lingering` 且占着 → 结束它（给整个组 SIGTERM，最多 1.5 秒，再 SIGKILL，最多 1 秒；还在就拒绝，helper 回 `previous_run_alive`，会话回 `computer_busy`）——它的撤回过期；然后启动执行层，写 `acting`。执行层在锁写好之后才收到请求。
- **`task_done`：** 改成 `lingering`，在把 `task_done` 转给任何人之前。
- **代数 `gen`（比较后再写）：** 拿锁时是 1，每次改状态（`task_done` 时 acting→lingering、撤回时 lingering→acting、`result_response` 后再回 lingering）都加 1。改状态的一方只从它上次看到的那个占用者（同一任务、同一进程组、同一状态、同一 `gen`）改；锁已经变了（撤回改过、新任务来过），就什么都不写——旧的写者不会把正在撤回的 `acting` 盖回 `lingering`。
- **先占后动（helper）：** 运行前要先动桌面的（`hands do` 要先把应用的窗口打开），先在同一步里「预占」：锁写成 helper 自己（`pgid: 0`，helper 活着就算占着）、`acting`；然后才动桌面；进程启动时再在 guard 里确认锁还是这个预占、写上它的进程组（`gen` 加 1）。被拒的请求什么都不碰桌面。
- **撤回：** 只有锁里正是这个任务且 `lingering` 才行，改回 `acting`；`result_response` 后改回 `lingering`。
- **没人管的占用：** 锁是 `acting`、组里还有进程活着，但 `owner` 和组长都不在了（比如 helper 被直接杀掉、执行层自己先退出了）：下一个任务先被拒（`computer_busy`），同时在锁里记下 `orphan_since`（1970 年起的秒）；过了 12 秒（和等 stop 一样长）再来的任务就结束这个组、接过锁——不能让它永远占着。启动它的一方还在时，执行层一退出，就看锁：锁里还是这个任务、还是 `acting`（没说 `task_done`，或撤回途中死了），等 12 秒，组里还有人就结束它们；`lingering` 的不用管，下一个任务会结束它。
- **启动时间：** 两边算的都是内核里的秒数（Swift 读 `pbi_start_tvsec`；Node 用 `ps -o lstart` 时设 `TZ=UTC0`，按 GMT 解析），和所在时区无关。
- **放锁：** 开始失败的那一次（执行层还没收到请求）：SIGKILL 它的组，确认没了，锁还正是它写的那个（同一 `gen`）就删掉。其他时候只在进程组确认没了之后：启动它的一方看到执行层退出时，锁还是这个任务、组里没人了，就删掉；组里还有子进程，锁照旧（`acting` 的话，下一个任务就是 `computer_busy`）。没人占的锁下一个人直接接过来。
- 以前的 `computer.last` 不再用：新任务拿锁时直接结束 `lingering` 的那一个，这台 Mac 上最多只有一个等结果卡的执行层。

**退出：** stdin 关了（app 走了）或收到 `end`（或闲着时的 `end_if_idle`），而且没有回复、任务在进行，重新打开时的补记也写完了（还在等旧执行层就等它，最多 12 秒；补记写不进去就按「任务的结局写不进去」退出码 3），正在做的撤回也有了结果（`respond` 转过去的撤回还没有 `result_response`：等它，最多 12 秒。过了时限还在做，**不打断它**——用户的东西不能撤到一半——也不写这个任务的 `task_closed`，进程照常退出（退出码 0），这个任务留着没关：执行层自己做完撤回，锁一直是它的（`acting`，它的组还在，别的任务拿不到；组没了、只剩它的子进程时，按「没人管的占用」12 秒后被新任务结束），下次打开时「重新打开」等它、或从运行记录读到它的真实结果，再关掉。一个任务的 `task_closed` 永远不会写在它要的撤回的结果之前：执行层退出（或新任务碰巧在它刚死、退出还没被看到时开始）时，撤回还没有记录，先从运行的 `events.jsonl` 读它的 `result_response`（执行层先写文件再写 stdout，退出可能先于那一行被看到），有就照它记，没有才记 `unknown`；之后 stdout 上再来的那一行不再记第二次。执行层的退出按它的 stdout 读完（`close`）算，所以通常那一行已经先到了。`end` 之后、进程真正退出之前来的 `respond` 照常执行（不拒绝）：这是用户对自己东西的明确决定，拒绝了它，这张卡在退出时也就过期了；按同一条规则，撤回的结果会先记下来，或留给下次打开），进程就关掉还在等结果卡的执行层，最多等它们 2 秒，然后退出（退出码 0）。这时哪条 `task_closed session_end`（或等不到停下时记的结局）写不进去，就按「任务的结局写不进去」结束执行层、放锁，退出码 3。stdin 关的时候正有回复，就等它说完、入库之后再退出；正有任务，见上面「app 走了」。SIGINT / SIGTERM 等同 `end`。

**会话列表：** `harness.mjs sessions list [--dir <d>]` 输出一个 JSON 数组，最新的在前：`{session_id, title, updated_at, last_message}`。`title` 是第一条用户消息的前 40 个字（超出加「…」，空白压成一个空格），`updated_at` 是最后一条入库事件的 `t`（秒），`last_message` 是 `{role, text}`（前 200 个字），没有消息时为 null。只读，不加锁。
