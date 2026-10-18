#!/usr/bin/env python3
"""From a Brain-judge run's events: every escalation (Brain's choice + confidence) paired with the cloud's final answer
   to the same question — did Brain agree with the cloud, by confidence bucket? Tells what floor is safe.
   python3 scripts/judge-calibration.py runs/local-B-brain-judge"""
import json, sys, glob, collections
d = sys.argv[1]
pairs = []   # (brain_choice, confidence, cloud_choice, question_head)
settled = collections.Counter()
for f in glob.glob(d + "/rep*/*/events.jsonl"):
    pending = None
    for l in open(f):
        e = json.loads(l); k = e.get("kind")
        if k == "judge.escalate" and e.get("tier") == "brain":
            pending = (e.get("choice"), e.get("confidence"))
        elif k == "judge.answer" and e.get("answer"):
            a = e["answer"]
            if a.get("by") == "brain": settled[a.get("choice")] += 1; pending = None
            elif pending is not None:
                pairs.append((pending[0], pending[1], a.get("choice"), (e.get("question") or "")[:12])); pending = None
buckets = collections.defaultdict(lambda: [0, 0])   # (brain choice kind, bucket) -> [agree, total]
approve_ids = {"matches", "pass", "r0"}
for bc, conf, cc, q in pairs:
    kind = "approve" if bc in approve_ids else "refuse/unsure"
    b = "none" if conf is None else f"{int(conf*10)/10:.1f}"
    buckets[(kind, b)][1] += 1
    if bc == cc: buckets[(kind, b)][0] += 1
print(f"Brain settled alone: {dict(settled)}   escalated and answered by the cloud: {len(pairs)}")
print(f"{'Brain said':16}{'confidence':>12}{'agreed with cloud':>20}")
for (kind, b), (agree, total) in sorted(buckets.items()):
    print(f"{kind:16}{b:>12}{agree:>10}/{total:<9}")
by_q = collections.defaultdict(lambda: [0, 0])    # question head -> [brain refused/unsure then cloud approved, escalations]
for bc, conf, cc, q in pairs:
    by_q[q][1] += 1
    if bc not in approve_ids and cc in approve_ids: by_q[q][0] += 1
print("\nescalations by question (cloud overturned Brain's refusal / escalations):")
for q, (ov, tot) in sorted(by_q.items(), key=lambda x: -x[1][1]): print(f"  {q:14} {ov}/{tot}")
wrong_refusals = [p for p in pairs if p[0] not in approve_ids and p[2] in approve_ids]
print(f"\nBrain refusals the cloud overturned (would have blocked right actions if final): {len(wrong_refusals)} of {sum(1 for p in pairs if p[0] not in approve_ids)}")
low_approvals = [p for p in pairs if p[0] in approve_ids]
print(f"Brain approvals below the floor: {len(low_approvals)}, of which the cloud agreed: {sum(1 for p in low_approvals if p[0]==p[2])}")
