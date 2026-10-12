/**
 * The simulated user's prompts and how its reply is read. Evaluation only: a stand-in for a person who knows the
 * task's facts (task.user_facts), not part of the harness.
 *
 * Each option is shown with what picking it makes the assistant do (its kind), and a pick must name the fact it rests
 * on. A pick whose fact the user does not hold is not taken: the user answers in their own words instead. (A small
 * model picked 「保留现有的，副本另存别的名字」 for a user whose answer was 「那就算了」: the option did not contradict
 * 「不想覆盖」, but it was not what the user would say.) A pick of content (a value, a way, 「可以」) must also
 * say what the user would say that the option leaves out; anything left out means the user says it in their own words
 * (the same model had picked 「按项目分文件夹」 for a user who also wanted drafts in 「草稿箱」).
 */
import type { Answer, Card, OptionKind } from "../orchestrator/index.js";
import type { UserFacts } from "./score.js";

const loose = (t: string) => t.replace(/[\s，。、；：！？「」“”‘’（）,.;:!?"'()]/g, "").toLowerCase();

const DOES: Record<OptionKind, string> = {
  approve: "照这样做", reading: "按这种理解做", value: "用这个", proposal: "按这个做法做", skip_step: "去掉这一步，其余照做",
  delegate: "交给助手决定", undo: "撤回已做的", undo_and_reading: "撤回，改成这种理解", other: "自己说", cancel: "停下，这件事不做了",
  never_ask_this: "以后不用告诉我",
};
/** Options that carry content the user may only partly agree with. */
// A reading answers one narrow point; the small model counted the user's other wishes as left out of it (skills-002),
// so a reading is taken on its fact alone.
const CONTENT: OptionKind[] = ["value", "proposal", "approve"];
const QUESTION: Card["kind"][] = ["missing", "ambiguity", "cannot"];

function options(card: Card): string {
  return "选项（方括号里是选了以后助手会怎么做）：\n" + card.options.map((o, i) => `${i}. [${DOES[o.kind] ?? o.kind}] ${o.text}`).join("\n");
}

/** What the user holds: the only things a pick may rest on. */
export function factsOf(f: UserFacts, card: Card): string[] {
  const question = QUESTION.includes(card.kind);
  return [f.intent, ...(question ? [f.answer] : []), ...(!question && f.approve === "no" ? ["你不同意助手照现在这样做。"] : [])];
}

const LABELS = { question: ["你真正的意思", "被问到时你会说"], confirm: ["你真正的意思"] };
/** The facts as the prompt lists them: 「label：fact」. */
function listed(f: UserFacts, card: Card): string[] {
  const labels = QUESTION.includes(card.kind) ? LABELS.question : LABELS.confirm;
  return factsOf(f, card).map((x, i) => `${labels[i] ?? "另外"}：${x}`);
}

const REPLY = '只输出 JSON：{"fact": "你依据的那条事实", "left_out": "关于助手问的这一点，你会说、但这个选项没说到的部分（都说到了就写空字符串）", "option": 编号} 或 {"text": "你的回答"}';
/** left_out is about the point asked only: other things the user wants are said when they are asked about. */
const LEFT_OUT = "left_out 只写和助手问的这一点有关、而选项没说到的部分；你的其他要求和这一点无关的，不算没说到。";

/** A question (missing information, an ambiguity, can't-do). */
export function questionPrompt(f: UserFacts, card: Card): string {
  return [
    "你在扮演一位用户。你心里知道的事实（只能依据这些作答）：",
    ...listed(f, card).map((x) => `- ${x}`),
    `助手问你：${card.text}`,
    options(card),
    "某个选项和你会说的话意思一样（不只是不违背你的意思，也不丢掉你在意的细节），才选它；否则用你自己的话回答，尽量照你会说的原话。不要选「交给助手决定」，除非你心里的意思就是让助手决定。",
    "选了选项，就在 fact 里原样抄出你依据的那条事实（上面列的一条，或其中一段），在 left_out 里写出你会说、但这个选项没说到的部分。" + LEFT_OUT,
    REPLY,
  ].join("\n");
}

/** A confirmation (plan, a single action, a result check). */
export function confirmPrompt(f: UserFacts, card: Card): string {
  return [
    "你在扮演一位用户。你心里知道的事实（只能依据这些作答）：",
    ...listed(f, card).map((x) => `- ${x}`),
    `助手请你确认：${card.text}`,
    options(card),
    "确认的内容完全是你要的（结果对、没有多做、不丢掉你在意的细节）才选[照这样做]；助手把你的意思理解错了，而某个选项正好说对了，就选那一项；你不想让这件事做下去才选[停下，这件事不做了]；都不合适就用你自己的话说清楚你要什么。",
    "选了选项，就在 fact 里原样抄出你依据的那条事实（上面列的一条，或其中一段），在 left_out 里写出你在意、但这个选项没做到的部分。" + LEFT_OUT,
    REPLY,
  ].join("\n");
}

/** The model's reply as an answer. A pick counts only with a fact the user holds; otherwise "unsupported". A content
 *  pick that leaves out something the user would say becomes the user's own words: their answer to a question, or
 *  what is left out on a confirmation. */
export function readPick(r: Record<string, unknown> | null, card: Card, f: UserFacts): Answer | "unsupported" | null {
  if (!r) return null;
  if (typeof r.option === "number" && r.option >= 0 && r.option < card.options.length) {
    // the fact is copied as listed (with its label, or several lines of the list): every line must be on the list
    const lines = (typeof r.fact === "string" ? r.fact : "").split("\n").map(loose).filter(Boolean);
    const held = listed(f, card).map(loose);
    if (!lines.length || !lines.every((l) => l.length >= 2 && held.some((h) => h.includes(l)))) return "unsupported";
    const left = typeof r.left_out === "string" ? r.left_out.trim() : "";
    if (!left || !CONTENT.includes(card.options[r.option]!.kind)) return { option: r.option };
    if (!card.free_text) return "unsupported";
    return { text: QUESTION.includes(card.kind) ? f.answer : left };
  }
  if (typeof r.text === "string" && r.text.trim() && card.free_text) return { text: r.text };
  return "unsupported";
}
