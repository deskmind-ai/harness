#!/usr/bin/env python3
"""Drive `app-run` by hand: prints the event stream and approves every card (a stand-in for the app while testing on
a real Mac). `python3 scripts/app-drive.py '{"raw":"…","scope":"/tmp/x","config":"yy-luna","driver":"hands"}'`."""
import json, subprocess, sys
req = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {"raw":"在文本编辑里新建一个文档，写上「你好 DeskMind」，保存为 hello.txt 放到任务目录","scope":"/tmp/dm-real","config":"yy-luna","driver":"hands"}
p = subprocess.Popen(["npx","tsx","src/cli/app.ts","app-run","--runs","runs/app"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
p.stdin.write(json.dumps(req, ensure_ascii=False)+"\n"); p.stdin.flush()
for line in p.stdout:
    try: e = json.loads(line)
    except ValueError: print("?", line.strip()[:200]); continue
    k = e["kind"]
    if k == "ask":
        card = e["card"]; opts = card["options"]
        pick = next((i for i,o in enumerate(opts) if o["kind"]=="approve"), None)
        print("CARD", card["kind"], card["text"][:160].replace("\n"," / "), "->", "approve" if pick is not None else "delegate")
        if pick is None: pick = next((i for i,o in enumerate(opts) if o["kind"]=="delegate"), 0)
        p.stdin.write(json.dumps({"ask_id": e["ask_id"], "option": pick})+"\n"); p.stdin.flush()
    elif k in ("step","consent","refused","task_done","plan","answer_given"):
        print(k, json.dumps({x:y for x,y in e.items() if x not in ("seq","t","run_id","kind")}, ensure_ascii=False)[:230])
    if k == "task_done": break
p.wait(timeout=30)
