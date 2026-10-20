# 运行时可插拔：换成 Codex、pi 等通用 agent（设计，10-20）

负责人 10-20 提出：harness 以后要能换成其他通用 agent，比如 Codex、pi、DeepSeek 的 agent。所以 DeskMind 的核心能力要能插拔，不能写死在 harness 的循环里。

这份文档回答三件事：
- 核心能力放在哪；
- 别的 agent 怎么接进来；
- 它们自带的工具怎么纳入我们的规矩。

用到的词：
- **运行时（agent 循环）：** 负责理解、计划、调工具的那一层。现在是 `src/runtime/loop.ts`（基于 pi-agent-core），以后可以换成 Codex、Claude Code、pi。
- **执行层：** `src/executor`。夹在运行时和电脑之间，负责归属、后果、同意、核对、停止和撤回。它已经可以作为 MCP 服务单独启动（`src/cli/mcp.ts`，服务名 deskmind-executor）。
- **宿主：** 运行 agent 的那个程序，比如 Codex CLI、Claude Code。钩子和沙箱都由宿主执行。

## 原则：守底线的放进模块，提质量的走标准扩展

负责人提出的两个选项不是二选一，而是分工：
- **选项 1（做进 app、Brain、Eyes、hands、执行层）** 决定能力放在哪里。
- **选项 2（skill、MCP、MCP Apps、CLI、钩子）** 决定 agent 怎么接进来。

判断标准是 agent 不配合时会怎样：
- **守底线的能力**（三条底线、归属、同意、停止）必须放进 agent 绕不过去的模块。agent 不按规矩来，模块就拒绝执行。
- **提质量的能力**（教程、基础规矩、结束前的提醒）走扩展。agent 不理会，结果只是变差，不会出事。

## 现状

- 执行层通过 MCP 提供 8 个工具：begin、snapshot、observe、plan、act、verify、stop、end。
- 我们自己的循环在同一个进程里直接调用执行层。给模型的工具是 computer_snapshot、computer_observe、computer_act、plan、fs_*（文件工具），另有只在循环里的 ask_user、answer、read_skill、finish。
- 执行层、判官、教程库和我们的循环在同一个包里，还没拆开。
- app 读 harness 进程（`harness.mjs app-run`）的一条事件流：文件变化来自执行层的账本（`executor.changes()`），结果卡和同意卡来自运行时。
- 同意凭证现在由 harness 进程里每次运行新生成的一对密钥签发，app 还没接钥匙串；下表「app 签名」是目标状态。

## 各项能力放在哪、怎么接

| 能力 | 放在哪 | 怎么接给 agent |
|---|---|---|
| 归属清单、后果下限、同意验签、撤回、回执 | 执行层（加 hands） | MCP 工具；没有凭证就拒绝 |
| 用户点「同意」 | app 签名（钥匙串） | 支持 MCP elicitation 的宿主走 elicitation；不支持的，执行层返回「需要同意」，由 app 弹卡 |
| 停止 | app 直接发给执行层 | 不经过 agent |
| 做没做成 | 执行层的 verify 加判官；app 只信执行层的结论 | Stop 类钩子让 agent 拿不到结论就继续，这只是提质量 |
| 判官（Brain、判官模型、路由表） | 执行层内部 | 不对外暴露；退路见下文「判官的档位与退路」 |
| 看屏幕 | hands；没有辅助功能信息的窗口，由 Eyes 从画面认（见「Eyes：从画面看的那一路」） | MCP 工具（snapshot、observe）；Eyes 不单独给 agent |
| 教程 | Agent Skills 文件，加 find_skills 工具 | observe 结果里按应用附上匹配的教程（见下文「借鉴 Codex 的电脑操作」）；宿主有提交钩子的，再注入一遍候选 |
| 基础规矩 | 基础技能 deskmind-computer-use | skill，或写进 AGENTS.md |
| 授权卡、结果卡、trace | app，数据来自执行层的事件 | 支持 MCP Apps 的宿主可以直接显示卡片（可选） |
| 没有 MCP 的 agent | — | 提供一个 CLI，作为兜底 |

## 编排通用 agent 自带的工具

通用 agent 往往自带 shell、改文件、跑代码，甚至自带电脑操作。这些能力不关掉，而是纳入我们的规矩：工具照用，但每次调用都要过执行层。按「事先能不能知道它会改什么」分成三种。

### 1. 事先就知道会改什么：改文件、打补丁、写入、调 MCP 工具

- 接在宿主的「调用前 / 调用后」钩子上：Codex 和 Claude Code 叫 PreToolUse / PostToolUse，pi 叫 beforeToolCall / afterToolCall。
- **调用前：** 钩子是我们提供的一个小命令，它把工具名和参数通过本机 socket 发给执行层。执行层按路径查开始时的归属清单，算出后果下限，然后回答三种结果之一：放行；拒绝并附理由；需要同意（同时交给 app 弹卡）。
- **在 Codex 上要注意钩子的写法：** Codex 的 PreToolUse 不支持「ask」这种决定，返回它会被当成放行；退出码不是 0 或 2、钩子出错、没有退出码，也都不拦。所以：
  - 「需要同意」要写成「拒绝，并说明要等用户在 app 里同意」，用户同意后由 agent 重试；
  - 钩子连不上执行层时，必须以退出码 2 结束（拦下），不能静默放行。
- **调用后：** 记回执，更新账本。

### 2. 事先不知道会改什么：shell、跑代码

- 不逐条判断。解析命令去猜效果，就是我们不做的那种启发式规则。
- 用系统沙箱把它关起来：
  - 只能写任务目录，用户的文件只读；
  - 默认断网，因为往外发属于要同意的一类。
- 用户同意改某个文件时，执行层把这个路径临时加进可写范围，正好对应「这次任务里的这个对象」那一档凭证。
- 事后用账本对比前后，变化照常记账、核对，和界面操作的处理方式一样。
- Codex 自带系统沙箱，可以设可写目录（writable roots），能直接用。Claude Code 和 pi 由我们在外面包一层沙箱。

### 3. 它们自带的电脑操作：按坐标点击

- 拿坐标在执行层的快照里查出是谁的窗口。任务自己的窗口放行；用户的窗口按「改用户的东西」处理，要同意。
- 它们的电脑操作没有回执，也没有核对，所以界面操作优先走执行层的 observe / act，它们自带的作为备用。

只读的（读文件、搜网页、看屏幕）直接用，不用拦，这就是「看得宽、动得窄」。

### 为什么钩子和沙箱两层都要

- **钩子**由宿主程序执行，模型跳不过去。它能逐个动作把关，还能把拒绝的理由告诉模型。
- **但钩子本身可能失灵：** Codex 的 PreToolUse 在几种异常情况下会直接放行：钩子返回了它不认识的决定（包括「ask」）、退出码不是 0 或 2、钩子本身出错（`codex-rs/hooks/src/events/pre_tool_use.rs` 里的 `*_fails_open` 测试和退出码处理）。用户或 agent 的配置也可能把钩子关掉。
- **沙箱**由操作系统强制，钩子失灵它也照样挡住，作为最后一道。
- 这和现有设计一致：运行时守第一道，执行层守最后一道。

## 判官的档位与退路

判官是执行层里的一段代码（`src/executor/judge.ts`）。执行层需要模型判断时，由它把题出成选择题，按档位交给模型来答。题有三类：
- 计划时：依据能不能区分有歧义的几种理解；
- 动手前：这一步是不是用户要的（只对改用户的东西、往外发的动作提问）；
- 结束时：做成了没有。

### 档位（负责人 10-20：没有快档和云端档时，交给 agent 的模型）

1. **Brain（本机）：** 只能放行，把握不够或不同意就交给下一档。
2. **单独配置的判官模型：** 可选，比如另一家模型。
3. **agent 自己的模型，单独调用：**
   - 我们自己的循环，直接用动手的模型另发一次调用；
   - 别的 agent 用 MCP 的 sampling：服务端请宿主的模型答一道题，并指定不带对话上下文。宿主得支持 sampling 才行，Codex 目前不支持（见「待定」）。
4. **都没有：** 返回「没有结论」，走保守的一边：
   - 计划时：去问用户；
   - 动手前：照常过同意这道门，和判官说「是」时一样。没有同意凭证才弹授权卡；计划里用户同意过的对象，不再弹；
   - 结束时：不算做成。

   每个任务的 40 题额度用完，或者低档拒绝之后高档都答不上来，也会返回「没有结论」。

宿主不支持 sampling 时，直接走第 4 档。不要退成「把题塞进对话里让 agent 自己答」，那等于让它给自己的动作打分。

**Codex 的先例：** Codex 打开自动审查（`approvals_reviewer = auto_review`，默认是 `user`，即由用户审批）时，对需要审批的动作请一个审查员判断。
- 审查员优先用专门的审查模型，并且用较低的推理强度；目录里没有这个模型时，退回用动手的同一个模型（`core/src/guardian/reviewer_config.rs` 的 `resolve_review_model`、`ext/guardian-reviewer/src/model.rs` 的 `select_review_model`）。
- 审查在分出来的会话里进行，但会带上压缩后的对话记录（`core/src/guardian/review_session.rs`、`prompt.rs`），不是不带上下文。
- 审查失败按拒绝处理（`ext/guardian-reviewer/src/completion.rs` 的 `FailedClosed`）。

我们沿用「退回动手的模型」和「失败按拒绝」，但更严：判官只看题目和证据，不带对话；再加上下面这条 Codex 没有的。

### 第 3 档能管多大的事

| 题 | 第 3 档可以答吗 | 理由 |
|---|---|---|
| 动手前：是不是用户要的 | 可以 | 放行之后，改用户的东西、往外发仍然要有同意凭证，越不过同意这道门 |
| 计划时：依据能不能区分 | 可以，结果要标出由谁判 | 答错的后果是少问用户一次。和现在默认配置里 Brain 放不了行时一样：交给和动手相同的 DeepSeek |
| 结束时：做成了没有 | 能答，但不能算「核对通过」 | 自己做、自己判，正是「没做成说成做成」这条底线要防的。结果写成「agent 自查通过，没有经过独立核对」 |

### 结果卡和 trace 写明是谁判的

- **独立判：** Brain，或另一家模型；
- **同一个模型、单独调用：** 现在默认配置里交给云端档的题（DeepSeek，和动手的相同），以及第 3 档；
- **没人判：** 走保守的一边。

现在的默认配置：Brain 就绪时先由 Brain 放行，其余交给和动手相同的 DeepSeek（app 设 `DESKMIND_BRAIN_JUDGE=1`，配置 ds-flash 所有角色都是 deepseek-flash）。所以加入第 3 档不会比现在差。每个回答已经记了由哪一档判（`by`），真正要补的是把它带到结果卡和 trace 上，让人看出结束时的核对是不是独立判的。

## Eyes：从画面看的那一路

（10-20 补充）

### 是什么

[deskmind-ai/eyes](https://github.com/deskmind-ai/eyes)：给一张截图和一句描述（「发送按钮」），返回要点的位置。
- 模型是 Eyes-4B：GUI-Owl-1.5-4B-Instruct 加一个用强化学习训的 LoRA。
- app 里用 4-bit MLX 在本机跑，服务只监听 127.0.0.1；截图按本机路径传，不离开这台 Mac。
- 按 app 的跑法，在 ScreenSpot-Pro 上是 50.9（文字 64.8，图标 28.3）；小图标是弱项。

### 现在怎么接

依据：app `app/Helper/HarnessRun.swift`；hands `deskmind_hands/vision.py`、`deskmind_hands/drivers/peekaboo.py`、`deskmind_hands/executor.py`。

- **app：** 任务提到访达、文本编辑以外的应用（`mayNeedVision`），而且 Eyes 模型已经下载，就先启动 Eyes 服务；90 秒内准备好，才把地址和令牌交给 hands（`HANDS_GROUNDER_URL`、`HANDS_GROUNDER_TOKEN`）。
- **hands 什么时候改从画面读：** 每次读一个应用时都检查辅助功能树：除了窗口自带的控件不到 3 个元素，就把这个应用记下，这次进程里之后都从画面读。
  - 判断靠的是读到的树，不靠应用名单（`VISION_APPS`、`VISION_VOCAB` 都是空的）；
  - 例外：访达和文本编辑按 bundle id 不切换；环境变量 `HANDS_VISION_APPS` 可以强制某个应用从画面读。
- **从画面读出的元素：**
  - 屏幕上的字：用 macOS 自带的文字识别（本机）认出来，按位置分组成列表项，每项一个可以点的元素，角色是 listitem。
  - 搜索框：一直提供。屏幕上的字说有搜索时，先定位好；否则定位一次，旁边有字才保留位置。
  - 常见的图标按钮（播放、暂停、返回、关闭、更多、设置、添加、发送、分享等 12 个，带中文名字，角色是 button）：
    - 不需要证据就列给模型，但模型选中了才让 Eyes 去定位；
    - 屏幕上已经有同一个字时，不再提供对应的图标；
    - 点了以后界面没有变化，就标记为不存在（屏幕上的字点了没变化也一样）。
    - 这样做是因为 Eyes 对不存在的目标也会给出一个位置（deskmind#68）。
- **动手：** 在元素中心按坐标点击（前台）；输入是粘贴加回车。
- **标记：** 图标、搜索框这些 hands 补出来的控件标了 `synthetic`，屏幕上的字没有标。执行层拿到的元素里没有这个标记，只能从 id 前缀（`ocr:`、`gen:`、`icon:`）看出来自画面。

### 在可插拔的设计里放在哪

- Eyes 属于执行层这一侧，挂在 hands 下面，是 observe 的第二个信息来源。它不单独给 agent，换哪个运行时都一样。
- 窗口归属、同意凭证，按窗口和动作算，和元素从哪来无关。

### 要补的三处

1. **元素带上来源：** observe 返回的每个元素加 `source`（`ax` 或 `pixels`）。来自画面的再带上把握（识别的置信度、Eyes 有没有核对过它存在）。模型、判官和授权卡都能看出这是从画面认出来的。
2. **画面元素的后果下限要保守（现有的缺口）：**
   - 现在「会不会往外发」靠元素的角色和文字判断（hands `executor.py` 的 `sends()`，只认按钮一类的角色）。
     - hands 补出来的「发送按钮」「分享按钮」角色是 button、名字以「发送」开头，会被认成往外发，这部分没问题。
     - 缺口在屏幕上的字：画面里认出的「发送」角色是 listitem，`sends()` 不认；而屏幕上出现这个字时，hands 又不再提供「发送按钮」。所以这时窗口里没有能认出的发送控件，点这个字、或者在这个窗口里按回车，都不会被当成往外发。
   - 后果（模型自己没有把类别报成「往外发」时）：
     - 在任务自己的窗口里，下限是「改任务自己的」，不需要同意；
     - 在用户的窗口里，下限是「改用户的」：判官仍会做意图核对，但计划里拿到的对象凭证（「改用户的」这一档）就能放行，不会为「往外发」再单独问一次。
   - **改法（10-20 负责人确认方向）：** 不只画面窗口，所有窗口的「会不会往外发」都改成由判官判断，按名字和回车得出的结果只作证据。见 `docs/outgoing-check-2026-10-20.md`。
3. **点之前先核对（deskmind#68）：**
   - Eyes 先回答「这个东西存不存在」，再给位置；
   - 位置要落在目标窗口里；
   - 点完界面没变化就标记为不存在（已有）。

### 给别的 agent

自带按坐标点击的 agent（比如 Codex），可以把 Eyes 的定位做成一个只读的 MCP 工具：`locate(window, description)`，返回位置和「存不存在」。它们真正去点的时候，仍然要过执行层「按坐标查窗口归谁」那一道。

## 借鉴 Codex 的电脑操作

依据 codex-cu（gxcsoccer/codex-cu，按 Codex Computer Use 的协议和行为做的复刻；README 写明自己的代码按 MIT 许可，仓库里没有单独的 LICENSE 文件）的 `docs/REPORT.md`、`docs/PROTOCOL.md`、`docs/CONFORMANCE.md`、`skill/codex-cu/SKILL.md`。

### 采用

| Codex 的做法 | 我们现在 | 改成 |
|---|---|---|
| 读一个应用的界面时，结果里附上这个应用的使用说明（`appSpecificInstructions`），客户端负责去重。codex-cu 照原版带了 7 份说明（音乐、时钟、Notion、Numbers、Slack、Spotify、iPhone 镜像），哪份对应哪个应用有一部分是推断的 | 教程候选靠用户提交请求时的钩子注入，换成别的 agent 不一定有这个钩子 | 执行层在返回 observe 结果时，按应用附上匹配的教程（只附名字和描述，全文按需读）。不靠宿主的钩子，换哪个 agent 都能拿到 |
| 元素 id 在整个进程里保持不变；系统通知界面有变化时把快照标成过期；下次动作时按角色、标识、标题、描述重新找到同一个元素，唯一匹配就直接用 | 画面版本号一变就退回 stale，模型要重看一遍，多花一轮 | 只读的动作和改任务自己东西的动作，改成按特征重新找元素。改用户的东西、往外发的动作仍然要求重看，保证授权卡上显示的是现在的样子 |
| 动作本身只返回成功与否；下一次读这个应用的界面时，返回和上一次相比的文字版差异：新增、改变、删掉的元素 | 动作返回完整的新画面，加上变化的数量 | observe 默认返回和上一次相比的差异，需要时再要全量。少花 token，模型也更容易看出「没有变化」 |
| 一个长期运行、签了名的服务进程，系统权限只授给这一个程序；会校验调用方：没有对应授权的进程得不到任何回应（错误码表里有 -10000 senderProcessNotAuthenticated；codex-cu 自己改成检查 socket 的属主） | 执行层由 app 拉起，没有校验调用方 | 执行层校验调用方，并给每个会话发一次性令牌。换成别的 agent 以后，谁都可能来连执行层，不校验的话，本机任何程序都能借我们拿到的权限去操作电脑 |

### 以后再看

- **模型写一段 JS，一次做好几个动作**（Codex 的 `cua` REPL）：轮数少、速度快。但一段脚本中途要弹授权卡、遇到界面过期、只做了一半，都会变复杂。现在先只让只读的看可以并行。
- **浏览器走 Playwright / CDP，并接入 Chrome 扩展：** 能直接读到网页里的元素，比现在用 Safari 脚本的办法强。但要操作用户自己的 Chrome，得装扩展，放到 0.5.x 的浏览器通道里再评估。
- **codex-cu 作为第二个驱动：** 挂在执行层下面，和 hands 放在同一个位置，用练习场比较两者谁更稳。

### 不采用

- **按应用授权**（`persistentApprovals` 里某个应用「总是允许 / 总是拒绝」，加上 `allowAllChats` 总开关）：这就是白名单，和负责人 10-17 定的「不按应用写规则」冲突。我们的同意是落到具体对象和具体动作上的凭证。
- **授权配置读不到时放行**：codex-cu 自己标明这是和原版不一致的地方。
- **「删除、发送之前先问用户」只写在技能文件里**（codex-cu 的 SKILL.md；原版是否也这样，没有核实）：这要靠模型自觉。我们这条由执行层强制。
- Codex 的 goal 模式有完成审查，但审查的是动手的模型自己，没有独立核对；也不区分东西归谁。这两样正是我们和它的区别。

## 局限

- 本地小模型那套按角色拆开的跑法，在通用 agent 上跑不了，还是留在我们自己的运行时里。
- 各家宿主对钩子、elicitation、sampling、skills 的支持程度不一样，接入后质量要分别量。
- agent 不理会教程、不理会结束前的提醒时，结果会变差；底线由执行层和沙箱保证，不受影响。

## 步骤

1. **拆出执行层：** 执行层、判官、教程库和判官用的模型网关拆成单独的包和进程。接口写成带版本号的规范：MCP 工具集、事件流（带序号，可以断点续收）、同意协议。
2. **app 只和执行层对接：** 同意卡、停止、结论、文件变化、trace 数据都从执行层拿，不从运行时拿。这一步决定 deskmind#90 第 2 条 trace 视图的数据从哪来，所以排在 trace 之前。
3. **执行层校验调用方：** 每个会话一次性令牌，不认识的调用方直接拒绝。
4. **接入验收：**
   - 用写死的模型回复专门测三条底线，不花模型调用，结果确定；
   - 再加练习场。
   - 任何 agent 接进来都先过这一套，成绩写明是哪个运行时、步数上限多少。
5. **先接 Codex：** 它的 MCP、elicitation、钩子、skills、沙箱最全，适合用来验证接口。然后接 pi，再接其他的。我们自己的运行时继续作为默认，本地模型的跑法也留在这里。
6. **借鉴项：** observe 附教程、按特征重新找元素、文字版差异，按上面「采用」表逐项做，每项用练习场量前后差别。
7. **Eyes：** 元素带上来源；「往外发」改由判官判断（`docs/outgoing-check-2026-10-20.md`，0.5.0 转正前做）；点之前核对存在（deskmind#68）。

## 待定

- **联网：** 系统沙箱本身只能整体开或关网络，分不出「读网页」和「往外发」。候选做法：
  - 默认断网，需要时每个任务请用户同意一次（最简单，也最守得住）；
  - 默认开网，往外发的风险只靠钩子把关；
  - 联网走代理，在代理上区分读和发。Codex 已经有这样的代理（`codex-network-proxy`）：有一种「受限」模式只放行 GET、HEAD、OPTIONS 请求，也能按域名放行或拦截。在 Codex 上可以直接用它的受限模式；按域名的名单是白名单，不用。其他宿主上，这条要我们自己做代理。
- **sampling 支持：**
  - Codex：源码只在 `codex-rs/rmcp-client/src/tool_input.rs` 解析 sampling 请求，客户端没有实现作答，对外声明的能力里也没有 sampling。按不支持处理：对 Codex，第 3 档目前等于第 4 档。要在 Codex 上有判官，得靠 Brain 或用户另配一个判官模型。
  - Claude Code 和 pi 是否支持，还没查。
- **「DeepSeek 的 agent」** 具体指哪个项目，待负责人给链接。

## 来源

- 本仓库：`src/runtime/loop.ts`、`src/executor/executor.ts`、`src/executor/judge.ts`、`src/cli/mcp.ts`。
- hands：`deskmind_hands/vision.py`、`deskmind_hands/drivers/peekaboo.py`、`deskmind_hands/executor.py`；Eyes：`deskmind-ai/eyes` 的 README；app：`app/Helper/HarnessRun.swift`。
- Codex 源码（本地 `openai/codex`）：`codex-rs/hooks/src/events/pre_tool_use.rs`、`codex-rs/core/src/guardian/`、`codex-rs/ext/guardian-reviewer/src/`、`codex-rs/rmcp-client/src/`、`codex-rs/network-proxy/`、`codex-rs/ext/goal/templates/goals/continuation.md`。
- codex-cu：`README.md`、`docs/REPORT.md`、`docs/PROTOCOL.md`、`docs/CONFORMANCE.md`、`docs/INSTALL.md`、`docs/REVERSE-ENGINEERING.md`、`docs/COMPATIBILITY.md`、`docs/OPEN-QUESTIONS.md`、`skill/codex-cu/SKILL.md`。
- 之前的设计：`docs/0.5-plan.md`、`docs/consent-spec.md`；openjev 仓库的 `docs/design/skills-layer-2026-10-18.md`、`docs/research/harness-survey-2026-10-18.md`。
- 流程图（现状，按代码画，含 Eyes 和 Brain）：https://claude.ai/artifact/K9nv8B478qrBf898M6ZoZq ；飞书版 https://bytedance.larkoffice.com/docx/P2m6dP5eaox38ZxrHvFcW3gVnKb
