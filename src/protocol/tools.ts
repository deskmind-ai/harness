/**
 * The executor port's tools as data (executor split P2, deskmind#90 item 6): one input schema per port method, used
 * both by our agent loop (the parameters of the tools the model is offered, runtime/loop.ts) and by the MCP server
 * (`tools/list`, cli/mcp.ts), so the two never drift apart. The schemas are TypeBox objects, which are JSON Schema; the
 * MCP list is them serialised (the golden file test/fixtures/mcp-tools.golden.json pins it).
 *
 * MCP tool names are the port's methods in snake_case (askUser → ask_user). `stop` is not a port method: it is the
 * caller's own stop switch on the standalone server (the app's stop reaches the executor through the control lines).
 */
import { Type, type Static, type TSchema } from "@earendil-works/pi-ai";
import { CONSEQUENCES } from "./consent.js";

const lit = <T extends string>(xs: readonly T[]) => Type.Union(xs.map((k) => Type.Literal(k)));

/** One action on screen, as a caller writes it. */
export const ActionSchema = Type.Object({
  kind: lit(["click", "double_click", "set_value", "type", "select", "key", "scroll", "open_window", "close_window", "focus_window", "wait"] as const),
  window: Type.Optional(Type.String({ description: "窗口 id（open_window、wait 不用）" })),
  target: Type.Optional(Type.String({ description: "元素 id，来自 computer_observe" })),
  value: Type.Optional(Type.String()), text: Type.Optional(Type.String()), option: Type.Optional(Type.String()),
  chord: Type.Optional(Type.String({ description: "按键，如 cmd+s、return" })), dy: Type.Optional(Type.Number()),
  app: Type.Optional(Type.String({ description: "open_window：应用名" })), url: Type.Optional(Type.String()), ms: Type.Optional(Type.Number()),
});
export type ActionIn = Static<typeof ActionSchema>;

export const ConsequenceSchema = lit(CONSEQUENCES);

/** A plan step: purpose, objects, consequence, and the URLs it opens with open_window (shown on the plan card). */
export const PlanStepSchema = Type.Object({ purpose: Type.String(), objects: Type.Array(Type.String()), consequence: ConsequenceSchema, opens: Type.Optional(Type.Array(Type.Object({ app: Type.String(), url: Type.String(), sends: Type.Optional(Type.String({ description: "网址会把什么发到这个网站，一句话，比如「搜索『北京天气』」" })) }), { description: "这一步用 open_window 打开的网址：应用、网址、发过去的内容" })) });
/** A point of the request that can be read more than one way: the reading chosen, the others, and what tells them apart. */
export const ReadingSchema = Type.Object({ point: Type.String(), reading: Type.String(), alternatives: Type.Array(Type.String()), evidence: Type.Array(Type.String()) });

// --- each port method's input ----------------------------------------------------------------------------------------
export const BeginParams = Type.Object({ raw: Type.String() });
export const SnapshotParams = Type.Object({});
export const ObserveParams = Type.Object({ window: Type.String() });
export const ActParams = Type.Object({ action: ActionSchema, epoch: Type.Number(), consequence: ConsequenceSchema, purpose: Type.String({ description: "这一步为了什么，一句话" }), plan_step: Type.Optional(Type.Number({ description: "这一步属于计划里的第几步（从 1 数）；没有计划就不填" })) });
export const ClassifyParams = Type.Object({ action: ActionSchema, epoch: Type.Optional(Type.Number()), consequence: Type.Optional(ConsequenceSchema) });
export const FileParams = Type.Object({ capability: Type.String(), args: Type.Record(Type.String(), Type.String()) });
export const PlanParams = Type.Object({ steps: Type.Array(PlanStepSchema), readings: Type.Optional(Type.Array(ReadingSchema)) });
export const AskUserParams = Type.Object({ question: Type.String(), options: Type.Array(Type.String()) });
export const AnswerParams = Type.Object({ text: Type.String() });
export const ReadSkillParams = Type.Object({ name: Type.String() });
export const FinishParams = Type.Object({ outcome: Type.Union([Type.Literal("done"), Type.Literal("unconfirmed"), Type.Literal("cannot"), Type.Literal("stopped")]), summary: Type.String(), missing: Type.Optional(Type.Array(Type.String())) });
export const SteersParams = Type.Object({});
export const EndParams = Type.Object({ failure: Type.Optional(Type.String()) });
export const StopParams = Type.Object({});

/** An MCP tool: its name, what it is for, its input schema (TypeBox, which is JSON Schema). */
export interface PortTool { name: string; description: string; parameters: TSchema }

export const PORT_TOOLS: PortTool[] = [
  { name: "begin", description: "开始任务：记下现在屏幕上的一切（都是用户的）。返回整台电脑、任务目录、可能适用的教程、可用的文件能力；ended 为真时任务开始不了（锁屏、读不到电脑），直接 end。整个任务只调一次。raw 是用户的原话。", parameters: BeginParams },
  { name: "snapshot", description: "整台电脑的状态：锁屏没有、最前面的应用、所有窗口（id、应用、标题、归谁 owner、浏览器标签页）。只读。", parameters: SnapshotParams },
  { name: "observe", description: "一个窗口的元素（id、角色、标签、值、能做的动作）、弹窗、文字。只读。动作要用这里的元素 id 和 epoch。", parameters: ObserveParams },
  { name: "classify", description: "只读：一个动作的后果类别（read / create / modify_user / external）、碰的对象、谁定的（结构、你报的更高类别、判官的哪一档、没有结论）、要不要用户同意。界面上会改东西的动作，判官会判断「会不会把内容发出去」，只往上调。act 动手时自己再算一次，不采信这里的结果；同一个动作在同一个 epoch 上只算一次。", parameters: ClassifyParams },
  { name: "act", description: "在界面上做一个动作。带上观察时的 epoch 和你判断的后果类别 consequence（read / create / modify_user / external；执行层只会往上调）。改用户的东西、往外发会先征得用户同意（执行层自己出卡、等用户回答，这次调用才返回）。文件动作用 file。", parameters: ActParams },
  { name: "file", description: "在任务目录上做一个文件能力（begin 返回的 files 之一：capability 和 args，路径相对任务目录），和 act 同样的守卫。", parameters: FileParams },
  { name: "plan", description: "动手前列出步骤：目的、涉及的对象（窗口 id / 标签页 id / 文件路径）、后果类别；有歧义处写 readings（选的理解、其他理解、区分它们的依据）。碰用户的东西、往外发之前必须有。依据不够的理解会先问用户；计划给用户过目。", parameters: PlanParams },
  { name: "ask_user", description: "只有用户知道的信息才问；options 是从证据里拿的候选，2–6 个，可以为空。用户的回答之后每个判官都看得到。", parameters: AskUserParams },
  { name: "answer", description: "把答案告诉用户（用户问的是问题时），然后 finish。", parameters: AnswerParams },
  { name: "read_skill", description: "读一份教程的全文（begin 列出的候选之一）。", parameters: ReadSkillParams },
  { name: "finish", description: "说任务结束了。done 会被独立核对，没过会告诉你缺什么；unconfirmed = 做了但确认不了；cannot = 做不到；stopped = 用户用自己的话让你停下。", parameters: FinishParams },
  { name: "steers", description: "取用户中途改的要求，并让它在这里生效（两步之间）。每一轮开始前调；回复带了 steers 的，之后的步骤在再调这个之前都不做。", parameters: SteersParams },
  { name: "end", description: "收尾：任务的结果（状态、原因、改了什么、结果卡）。failure：调用方放弃的原因（预算、模型出错），执行层自己没定状态时才用。", parameters: EndParams },
  { name: "stop", description: "停止开关：之后的动作一律拒绝，开着的卡不再等。", parameters: StopParams },
];

/** The MCP `tools/list` entries: name, description, input schema as plain JSON. */
export const mcpTools = () => PORT_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: JSON.parse(JSON.stringify(t.parameters)) as Record<string, unknown> }));
