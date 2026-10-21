#!/usr/bin/env python3
"""Drive the ops console in headless Chrome over CDP: screencast frames +
real input clicks. Re-records video 1: ops abort-settle of a pending run,
then the buyer/seller flow on a fresh market.

Prereqs: infra/dev-servers.sh running; launch headless Chrome first:
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    --headless=new --user-data-dir=/tmp/mr-headless --remote-debugging-port=9333 \
    --remote-allow-origins='*' --window-size=1600,1000 --hide-scrollbars \
    "http://localhost:8787/ops"
Then: python docs/videos/cdp_video1.py
Frames land in docs/videos/frames1h/ — dedupe and assemble with ffmpeg.
"""
import base64, json, subprocess, time, urllib.request
import websocket

DEBUG = "http://localhost:9333"
OUT = "/Users/bundu/Documents/market-runs/docs/videos/frames1h"
subprocess.run(["mkdir", "-p", OUT], check=True)

targets = json.load(urllib.request.urlopen(f"{DEBUG}/json"))
page = next(t for t in targets if t["type"] == "page" and "localhost:8787" in t["url"])
ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=30)
mid = 0
frames = []

def send(method, params=None):
    global mid
    mid += 1
    ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
    while True:
        msg = json.loads(ws.recv())
        if msg.get("id") == mid:
            return msg.get("result", {})
        handle_event(msg)

def handle_event(msg):
    if msg.get("method") == "Page.screencastFrame":
        p = msg["params"]
        frames.append((p["sessionId"], base64.b64decode(p["data"])))
        try:
            ws.send(json.dumps({"id": 0, "method": "Page.screencastFrameAck",
                                "params": {"sessionId": p["sessionId"]}}))
        except Exception:
            pass

def drain(seconds):
    end = time.time() + seconds
    ws.settimeout(0.5)
    while time.time() < end:
        try:
            handle_event(json.loads(ws.recv()))
        except websocket.WebSocketTimeoutException:
            pass
    ws.settimeout(30)

def click_button(text):
    rect = send("Runtime.evaluate", {"expression":
        f"""(() => {{
          const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes({json.dumps(text)}));
          if (!b) return null;
          b.scrollIntoView();
          const r = b.getBoundingClientRect();
          return JSON.stringify({{x: r.x + r.width/2, y: r.y + r.height/2}});
        }})()""", "returnByValue": True})["result"].get("value")
    if not rect:
        print(f"BUTTON NOT FOUND: {text}")
        return False
    x, y = json.loads(rect).values()
    for t in ("mousePressed", "mouseReleased"):
        send("Input.dispatchMouseEvent", {"type": t, "x": x, "y": y, "button": "left", "clickCount": 1})
    print(f"clicked {text} at ({x:.0f},{y:.0f})")
    return True

def set_field(fid, value):
    send("Runtime.evaluate", {"expression":
        f"""(() => {{ const el = document.getElementById({json.dumps(fid)});
           el.value = {json.dumps(value)}; el.dispatchEvent(new Event('input')); return el.value; }})()""",
        "returnByValue": True})
    print(f"set {fid} = {value}")

send("Page.enable")
send("Page.startScreencast", {"format": "jpeg", "quality": 75, "everyNthFrame": 1})
drain(3)

# 1) ops adjustment: abort the pending run (ADR-0008 partial refund)
set_field("settleMode", "aborted")
drain(1)
click_button("Release settlement")
drain(8)

# 2) fresh buyer/seller flow on a new market
set_field("market", "Oyingbo")
drain(1)
click_button("Buyer posts intent")
drain(6)
click_button("Seller offers product")
drain(6)
click_button("Buyer negotiates")
drain(5)
click_button("Buyer accepts")
drain(6)
click_button("Buyer checks out")
drain(10)

send("Page.stopScreencast")
drain(1)
ws.close()

for i, (_, data) in enumerate(frames):
    with open(f"{OUT}/f_{i:04d}.jpg", "wb") as fh:  # screencast jpeg data
        fh.write(data)
print(f"saved {len(frames)} frames to {OUT}")
