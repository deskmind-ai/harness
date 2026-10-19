#!/usr/bin/env python3
"""Compare a cloud-judge run (A) with a Brain-judge run (B) of the same tasks: effect, cost, speed, privacy.
   python3 scripts/compare-local.py runs/local-A-cloud-judge runs/local-B-brain-judge [--price 0.30e-6,1.20e-6]"""
import json, sys, glob, collections, statistics as st
price = (0.30e-6, 1.20e-6)
args = [a for a in sys.argv[1:] if not a.startswith("--")]
for a in sys.argv[1:]:
    if a.startswith("--price="): price = tuple(float(x) for x in a[8:].split(","))
def load(d):
    rows = [json.loads(l) for l in open(d + "/results.jsonl")]
    judge = collections.Counter(); esc = 0; unsettled = 0; qs = 0; skipped = 0; shadow = [0, 0]   # [agree, compared]
    for f in glob.glob(d + "/**/events.jsonl", recursive=True):
        for l in open(f):
            e = json.loads(l); k = e.get("kind")
            if k == "judge.answer" and e.get("answer"): judge[e["answer"].get("by", "?")] += 1; qs += 1
            if k == "judge.escalate": esc += 1
            if k == "judge.unsettled": unsettled += 1
            # the first runs with these events recorded them under the question's kind (the body's `kind` key
            # overwrote the event's); recognised by their fields
            keys = set(e.keys()) - {"seq", "t", "kind"}
            if k == "judge.skipped" or keys == {"tier"}: skipped += 1
            if (k == "judge.shadow" or {"tier", "choice", "top", "agree"} <= keys) and e.get("agree") is not None: shadow[1] += 1; shadow[0] += int(bool(e.get("agree")))
    # the gateway's log: every cloud call outside the actor's loop (judge tiers, teach); the local Brain tier is not
    # logged here, so what is missing in B against A is what stayed on the machine
    gw = {"calls": 0, "tokens_in": 0, "tokens_out": 0, "latency_ms": 0, "user_chars": 0}
    try:
        for l in open(d + "/model_calls.jsonl"):
            e = json.loads(l)
            if e.get("role") in ("intent", "verify", "choice"):
                if e.get("outcome") != "answered" and "Abort" in (e.get("error") or ""): gw["aborted"] = gw.get("aborted", 0) + 1; continue   # the race: abandoned cloud calls
                gw["calls"] += 1; gw["tokens_in"] += e.get("tokens_in", 0); gw["tokens_out"] += e.get("tokens_out", 0)
                gw["latency_ms"] += e.get("latency_ms", 0); gw["user_chars"] += e.get("user_chars", 0) + e.get("system_chars", 0)
    except OSError:
        pass
    gw["skipped"] = skipped; gw["shadow"] = shadow
    return rows, judge, esc, unsettled, qs, gw
def summ(rows):
    n = len(rows); cats = collections.defaultdict(list)
    for r in rows: cats[r.get("category", "?")].append(r)
    acc = {c: sum(1 for r in v if r.get("correct")) / len(v) for c, v in cats.items()}
    ti = sum(r.get("tokens_in", 0) for r in rows); to = sum(r.get("tokens_out", 0) for r in rows)
    return {
        "n": n, "mean": st.mean(acc.values()) if acc else 0, "lowest": min(acc.values()) if acc else 0, "by_cat": acc,
        "wrong": sum(1 for r in rows if r.get("wrong_effect")), "false_success": sum(1 for r in rows if r.get("false_success")),
        "unconsented": sum(1 for r in rows if r.get("unconsented")), "interruptions": sum(r.get("interruptions", 0) for r in rows),
        "model_calls": sum(r.get("model_calls", 0) for r in rows) / n, "loop_calls": sum(r.get("loop_calls", 0) for r in rows) / n,
        "tokens_in": ti / n, "tokens_out": to / n, "usd": (ti * price[0] + to * price[1]) / n, "seconds": st.mean(r.get("seconds", 0) for r in rows),
    }
out = {}
for name, d in zip("AB", args[:2]):
    rows, judge, esc, unsettled, qs, gw = load(d)
    s = summ(rows); s["judge_by"] = dict(judge); s["judge_questions"] = qs; s["escalations"] = esc; s["unsettled"] = unsettled
    s["local_share"] = (judge.get("brain", 0) / qs) if qs else 0
    n = max(1, s["n"])
    s["judge_cloud_calls"] = gw["calls"] / n; s["judge_tokens_in"] = gw["tokens_in"] / n; s["judge_tokens_out"] = gw["tokens_out"] / n
    s["judge_latency_s"] = gw["latency_ms"] / 1000 / n; s["judge_chars_cloud"] = gw["user_chars"] / n
    s["usd_all"] = s["usd"] + (gw["tokens_in"] * price[0] + gw["tokens_out"] * price[1]) / n
    s["skipped"] = gw["skipped"]; s["shadow"] = gw["shadow"]; s["aborted"] = gw.get("aborted", 0) / n
    out[name] = s
A, B = out.get("A"), out.get("B")
def pct(x): return f"{100*x:.0f}%"
print(f"{'':28}{'A 云端判官':>14}{'B Brain 快档':>14}{'变化':>12}")
def row(label, a, b, fmt=lambda v: f"{v:.2f}", better="low"):
    d = "" if a in (0, None) else (f"{(b-a)/a*100:+.0f}%" if isinstance(a, (int, float)) and a else "")
    print(f"{label:28}{fmt(a):>14}{fmt(b):>14}{d:>12}")
row("题数", A["n"], B["n"], lambda v: str(v))
row("平均正确率", A["mean"], B["mean"], pct); row("最低类", A["lowest"], B["lowest"], pct)
row("做错 / 谎报 / 越权", (A["wrong"], A["false_success"], A["unconsented"]), (B["wrong"], B["false_success"], B["unconsented"]), lambda v: "/".join(map(str, v)))
row("打扰（卡）总数", A["interruptions"], B["interruptions"], str)
row("云端模型调用/题", A["model_calls"], B["model_calls"]); row("  其中动手模型/题", A["loop_calls"], B["loop_calls"])
row("云端 token 入/题", A["tokens_in"], B["tokens_in"], lambda v: f"{v:.0f}"); row("云端 token 出/题", A["tokens_out"], B["tokens_out"], lambda v: f"{v:.0f}")
row("判官云端调用/题", A["judge_cloud_calls"], B["judge_cloud_calls"]); row("判官云端 token 入/题", A["judge_tokens_in"], B["judge_tokens_in"], lambda v: f"{v:.0f}")
row("判官云端等待 秒/题", A["judge_latency_s"], B["judge_latency_s"], lambda v: f"{v:.1f}")
row("美元/题 动手模型", A["usd"], B["usd"], lambda v: f"${v:.5f}"); row("美元/题 含判官", A["usd_all"], B["usd_all"], lambda v: f"${v:.5f}")
row("判官材料出本机 字符/题", A["judge_chars_cloud"], B["judge_chars_cloud"], lambda v: f"{v:.0f}")
row("秒/题", A["seconds"], B["seconds"], lambda v: f"{v:.1f}")
row("判官问题数（总）", A["judge_questions"], B["judge_questions"], str)
row("  本地（Brain）定的", A["judge_by"].get("brain", 0), B["judge_by"].get("brain", 0), str)
row("  本地占比", A["local_share"], B["local_share"], pct)
row("  升云端 / unsettled", (A["escalations"], A["unsettled"]), (B["escalations"], B["unsettled"]), lambda v: "/".join(map(str, v)))
row("  自适应跳过（没问快档）", A["skipped"], B["skipped"], str)
row("  影子核对 一致/比较", tuple(A["shadow"]), tuple(B["shadow"]), lambda v: "/".join(map(str, v)))
row("  竞速中放弃的云端调用/题", A["aborted"], B["aborted"])
print("\n按类正确数:")
for c in sorted(set(A["by_cat"]) | set(B["by_cat"])):
    print(f"  {c:12} A {pct(A['by_cat'].get(c,0)):>5}  B {pct(B['by_cat'].get(c,0)):>5}")
