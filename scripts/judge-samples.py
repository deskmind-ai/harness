#!/usr/bin/env python3
"""Collect the judge's training samples (every question the fast and the slow tier both answered) from run
   directories into one JSONL for DeskMind Brain: {kind, prompt, options, brain: {choice, confidence}, cloud: choice}.
   python3 scripts/judge-samples.py runs/gym-local-F-samples [more dirs] > judge-samples.jsonl"""
import json, sys, glob, collections
out = []; seen = set()
for d in sys.argv[1:]:
    for f in glob.glob(d + "/**/events.jsonl", recursive=True):
        for l in open(f):
            e = json.loads(l)
            if e.get("kind") != "judge.sample": continue
            key = (e["prompt"], e["top"])
            if key in seen: continue
            seen.add(key)
            out.append({"kind": e.get("question_kind"), "prompt": e["prompt"], "options": e["options"], "brain": e["lower"], "cloud": e["top"], "agree": e["lower"]["choice"] == e["top"]})
for r in out: print(json.dumps(r, ensure_ascii=False))
c = collections.Counter((r["kind"].split("|")[0][:6], r["agree"]) for r in out)
print(f"# {len(out)} samples; by kind (agree): {dict(c)}", file=sys.stderr)
