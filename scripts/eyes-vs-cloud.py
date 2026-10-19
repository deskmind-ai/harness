#!/usr/bin/env python3
"""Eyes (local grounder) against a cloud vision model on the same screenshots and queries: latency, cost, bytes
   uploaded, and agreement (points within 3% of the window width). Needs the app's Eyes server up.
   python3 scripts/eyes-vs-cloud.py <dir with obs-*.png> [--queries 搜索框,关闭按钮（面板/弹窗）,播放按钮]"""
import json, sys, os, glob, time, base64, urllib.request, statistics as st
d = sys.argv[1]; queries = ["搜索框", "关闭按钮（面板/弹窗）", "播放按钮"]
for a in sys.argv[2:]:
    if a.startswith("--queries="): queries = a[10:].split(",")
tok = open(os.path.expanduser("~/Library/Application Support/DeskMind/servers.token")).read().strip()
W, H = 1059, 752
def eyes(shot):
    body = {"image": os.path.abspath(shot), "size": [W, H], "queries": {f"q{i}": q for i, q in enumerate(queries)}}
    req = urllib.request.Request("http://127.0.0.1:18851/ground", data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "Authorization": "Bearer " + tok})
    t = time.time(); pts = json.loads(urllib.request.urlopen(req, timeout=180).read()).get("points", {})
    return time.time() - t, {queries[i]: pts.get(f"q{i}") for i in range(len(queries))}
def cloud(shot):
    b64 = base64.b64encode(open(shot, "rb").read()).decode(); out = {}; lat = 0; tin = 0; tout = 0
    for q in queries:
        body = {"model": "doubao-seed-evolving", "temperature": 0, "thinking": {"type": "disabled"}, "response_format": {"type": "json_object"},
                "messages": [{"role": "user", "content": [{"type": "image_url", "image_url": {"url": "data:image/png;base64," + b64}},
                             {"type": "text", "text": f"这是一个 {W}x{H} 的窗口截图。「{q}」在哪里？只输出 JSON {{\"x\": 0 到 1 的横向比例, \"y\": 0 到 1 的纵向比例, \"absent\": 没有这个控件就 true}}。"}]}]}
        req = urllib.request.Request("https://ark.cn-beijing.volces.com/api/v3/chat/completions", data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "Authorization": "Bearer " + os.environ["VOLCENGINE_API_KEY"]})
        t = time.time()
        try:
            r = json.loads(urllib.request.urlopen(req, timeout=120).read()); lat += time.time() - t
            u = r.get("usage", {}); tin += u.get("prompt_tokens", 0); tout += u.get("completion_tokens", 0)
            j = json.loads(r["choices"][0]["message"]["content"]); out[q] = None if j.get("absent") else [j.get("x"), j.get("y")]
        except Exception as e:  # noqa: BLE001
            lat += time.time() - t; out[q] = f"ERR {e}"
    return lat, out, tin, tout
shots = sorted(glob.glob(os.path.join(d, "obs-*.png")))
rows = []; up = 0
for s in shots:
    el, ep = eyes(s); cl, cp, tin, tout = cloud(s); up += os.path.getsize(s)
    rows.append((os.path.basename(s), el, ep, cl, cp, tin, tout))
agree = total = 0; both_absent = 0
for name, el, ep, cl, cp, tin, tout in rows:
    for q in queries:
        a, b = ep.get(q), cp.get(q)
        if isinstance(b, str): continue
        if a is None and b is None: both_absent += 1; continue
        total += 1
        if a and b and abs(a[0] - b[0]) * W <= 0.03 * W and abs(a[1] - b[1]) * H <= 0.03 * W: agree += 1
n = len(rows)
print(f"screenshots {n}, queries {len(queries)} each")
print(f"Eyes   : {st.mean(r[1] for r in rows):.2f} s per screenshot (all queries), $0, 0 bytes uploaded")
print(f"cloud  : {st.mean(r[3] for r in rows):.2f} s per screenshot, tokens in {sum(r[5] for r in rows)} out {sum(r[6] for r in rows)}, "
      f"${(sum(r[5] for r in rows)*0.89e-6 + sum(r[6] for r in rows)*4.45e-6):.4f} total, {up/1e6:.1f} MB uploaded")
print(f"agreement (both placed, within 3% of width): {agree}/{total}; both said absent: {both_absent}")
