#!/usr/bin/env python3
"""Resume the app flow from a live run with a pending handoff (screens 14-18)."""
import base64, json, time, urllib.request
import websocket

DEBUG = "http://localhost:9334"
OUT = "/Users/bundu/Documents/market-runs/docs/videos/frames3"
targets = json.load(urllib.request.urlopen(f"{DEBUG}/json"))
page = next(t for t in targets if t["type"] == "page" and "localhost:8081" in t["url"])
ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=60)
mid = 0
def send(method, params=None):
    global mid
    mid += 1
    ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
    while True:
        msg = json.loads(ws.recv())
        if msg.get("method") == "Page.javascriptDialogOpening":
            send("Page.handleJavaScriptDialog", {"accept": True}); continue
        if msg.get("id") == mid:
            return msg.get("result", {})
def js(expr):
    r = send("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True})
    if "exceptionDetails" in r: raise RuntimeError(json.dumps(r["exceptionDetails"])[:300])
    return r.get("result", {}).get("value")
def server_state(path):
    return json.load(urllib.request.urlopen("http://localhost:8787" + path, timeout=5))
def snap(label):
    import glob
    n = len(glob.glob(f"{OUT}/s_*.jpg"))
    data = send("Page.captureScreenshot", {"format": "jpeg", "quality": 80})["data"]
    open(f"{OUT}/s_{n:03d}_{label}.jpg", "wb").write(base64.b64decode(data))
    print(f"[{n:03d}] {label}")
def wait_for(text, timeout=20):
    end = time.time() + timeout
    while time.time() < end:
        try:
            if js(f"document.body.innerText.includes({json.dumps(text)})"): return True
        except Exception: pass
        time.sleep(0.5)
    raise RuntimeError(f"never appeared: {text}")

send("Page.enable"); send("Runtime.enable")
send("Page.reload", {"ignoreCache": True}); time.sleep(6)
run = server_state("/runs/run:cart:Balogun")["run"]
handoff_id = run["handoffs"][-1]["id"]
js("window.location.href = '/runner/handoff?handoffId=" + handoff_id + "'")
wait_for("CONFIRMED", 15)
snap("14-handoff-confirmed")
def click_text(text):
    ok = js(f"""(() => {{
      const els = [...document.querySelectorAll('div')]
        .filter(e => ((e.innerText || '').includes({json.dumps(text)}) && e.children.length === 0) || (e.innerText || '').trim() === {json.dumps(text)})
        .filter(e => e.getBoundingClientRect().width > 0)
        .sort((a, b) => a.getBoundingClientRect().width - b.getBoundingClientRect().width);
      if (!els.length) return false;
      const el = els[0];
      for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) {{
        el.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, {{bubbles:true, cancelable:true, view:window, clientX: el.getBoundingClientRect().x+4, clientY: el.getBoundingClientRect().y+4, button:0}}));
      }}
      return true;
    }})()""")
    if not ok: raise RuntimeError(f"not clickable: {text}")

click_text("Capture evidence")
time.sleep(2.5)
snap("16-evidence")
js("window.location.href = '/runner'")
wait_for("COMPLETED", 15)
snap("17-stop-completed")
click_text("Final delivery")
wait_for("DELIVERED", 15)
snap("18-delivered")
ws.close()
print("runner flow complete")
