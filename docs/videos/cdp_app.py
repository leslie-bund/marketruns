#!/usr/bin/env python3
"""Drive the REAL Expo app (web build) end-to-end over CDP against the live
dev edge. One run through all three roles: buyer posts an intent, the seller
responds, the buyer negotiates and accepts, checks out, and the runner runs
the handoff. Screenshots land in docs/videos/frames3/.

Prereqs: infra/dev-servers.sh running + `npx expo start --web --port 8081`.
Launch headless Chrome first:
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    --headless=new --user-data-dir=/tmp/mr-app --remote-debugging-port=9334 \
    --remote-allow-origins='*' --window-size=1400,1000 --hide-scrollbars \
    "http://localhost:8081"
Then: python docs/videos/cdp_app.py
"""
import base64, json, subprocess, time, urllib.request
import websocket

DEBUG = "http://localhost:9334"
OUT = "/Users/bundu/Documents/market-runs/docs/videos/frames3"
APP = "http://localhost:8081"
subprocess.run(["mkdir", "-p", OUT], check=True)

targets = json.load(urllib.request.urlopen(f"{DEBUG}/json"))
page = next(t for t in targets if t["type"] == "page" and "localhost:8081" in t["url"])
ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=60)
mid = 0
shot = 0

def send(method, params=None):
    global mid
    mid += 1
    ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
    while True:
        msg = json.loads(ws.recv())
        if msg.get("method") == "Page.javascriptDialogOpening":
            send("Page.handleJavaScriptDialog", {"accept": True})
            continue
        if msg.get("id") == mid:
            return msg.get("result", {})

def js(expr):
    result = send("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True})
    if "exceptionDetails" in result:
        raise RuntimeError(json.dumps(result["exceptionDetails"])[:400])
    return result.get("result", {}).get("value")

def sleep_frames(seconds):
    time.sleep(seconds)

def snap(label):
    global shot
    data = send("Page.captureScreenshot", {"format": "jpeg", "quality": 80})["data"]
    with open(f"{OUT}/s_{shot:03d}_{label}.jpg", "wb") as fh:
        fh.write(base64.b64decode(data))
    shot += 1
    print(f"[{shot:03d}] {label}")

def click_text(text, tag="button", last=False):
    ok = js(f"""(() => {{
      const els = [...document.querySelectorAll('div')]
        .filter(e => (e.innerText || '').trim() === {json.dumps(text)} ||
                     ((e.innerText || '').includes({json.dumps(text)}) && e.children.length === 0))
        .filter(e => e.getBoundingClientRect().width > 0)
        .sort((a, b) => a.getBoundingClientRect().width - b.getBoundingClientRect().width)
        .map(e => {{ const r = e.getBoundingClientRect(); return JSON.stringify([r.x + r.width / 2, r.y + r.height / 2]); }});
      return JSON.stringify(els);
    }})()""")
    if not ok:
        raise RuntimeError(f"not clickable: {text}")
    rects = json.loads(ok)
    if not rects:
        raise RuntimeError(f"not clickable: {text}")
    x, y = json.loads(rects[-1 if last else 0])
    js(f"""(() => {{
      const el = document.elementFromPoint({x}, {y});
      if (!el) return false;
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {{
        el.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, {{
          bubbles: true, cancelable: true, view: window, clientX: {x}, clientY: {y}, button: 0,
        }}));
      }}
      return true;
    }})()""")
    return True

def set_input(index, value):
    js(f"""(() => {{
      const els = [...document.querySelectorAll('input, textarea')].filter(e => e.getBoundingClientRect().width > 0);
      const el = els[{index}];
      if (!el) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, {json.dumps(value)});
      el.dispatchEvent(new Event('input', {{bubbles: true}}));
      return true;
    }})()""") or (_ for _ in ()).throw(RuntimeError(f"no input at index {index}"))


def server_state(path):
    import urllib.request as u
    return json.load(u.urlopen("http://localhost:8787" + path, timeout=5))

def wait_product_offered(timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        try:
            intents = server_state("/markets/Balogun/intents")["intents"]
            for intent in reversed(intents):
                ids = server_state("/markets/Balogun/intents/" + intent["id"] + "/products")["productIds"]
                if ids:
                    return ids[-1]
        except Exception as exc:
            print("wait_product_offered error:", repr(exc)[:200])
        time.sleep(1)
    raise RuntimeError("product never indexed")

def wait_cart_has_product(timeout=20):
    end = time.time() + timeout
    while time.time() < end:
        try:
            cart = server_state("/carts/cart:Balogun")["cart"]
            if cart["products"]:
                return True
        except Exception:
            pass
        time.sleep(1)
    raise RuntimeError("cart never filled")

def wait_for(text, timeout=20):
    end = time.time() + timeout
    while time.time() < end:
        try:
            if js(f"document.body.innerText.includes({json.dumps(text)})"):
                return True
        except Exception:
            pass
        time.sleep(0.5)
    raise RuntimeError(f"text never appeared: {text}")

send("Page.enable")
send("Runtime.enable")

# Wait for the app to hydrate and show the live pill.
for _ in range(60):
    try:
        if js("document.body.innerText.includes('LIVE') || document.body.innerText.includes('OFFLINE')"):
            break
    except Exception:
        pass
    time.sleep(2)
snap("00-launch")

# ---- BUYER: post an intent ----
js("window.location.href = '/buyer'")
sleep_frames(2.5)
snap("01-buyer-home")
click_text("Post an Intent")
sleep_frames(1.5)
set_input(0, "Tomatoes")
set_input(1, "2")
set_input(3, "1200")
set_input(4, "1800")
snap("02-intent-form")
click_text("Post Intent")
sleep_frames(2.5)
snap("03-intent-posted")

# ---- SELLER: respond with a product ----
js("window.location.href = '/seller'")
sleep_frames(2.5)
snap("04-seller-demand")
click_text("Respond with Product", last=True)
sleep_frames(1.5)
set_input(2, "1650")
snap("05-respond-form")
click_text("Send Product")
product_id = wait_product_offered()
sleep_frames(1)
snap("06-product-sent")

# ---- BUYER: negotiate and accept ----
js("window.location.href = '/buyer/products'")
wait_for("2 kg Tomatoes", 25)
sleep_frames(1)
snap("07-products")
click_text("Open Negotiation")
sleep_frames(2.5)
set_input(0, "1600")
click_text("Send price")
sleep_frames(2)
snap("08-negotiated")
click_text("Accept Product")
wait_cart_has_product()
sleep_frames(1)
snap("09-accepted")
js("window.location.href = '/buyer/cart'")
sleep_frames(2.5)
snap("10-cart")

# ---- BUYER: checkout ----
click_text("Checkout")
sleep_frames(1.5)
snap("11-checkout")
click_text("Confirm checkout")
wait_for("Run confirmed", 15)
snap("12-run-assigned")

# ---- RUNNER: handoff ----
js("window.location.href = '/runner'")
wait_for("Floor Rate", 15)
snap("13-runner-run")
click_text("Open Handoff at")
sleep_frames(2)
handoff_id = server_state("/runs/run:cart:Balogun")["run"]["handoffs"][-1]["id"]
js("window.location.href = '/runner/handoff?handoffId=' + " + "json.dumps(handoff_id)")
wait_for("AUTO-CONFIRM", 10)
snap("14-handoff")
click_text("Simulate scan")
wait_for("CONFIRMED", 15)
snap("15-scanned")
click_text("Capture evidence")
sleep_frames(2.5)
snap("16-evidence")
js("window.location.href = '/runner'")
wait_for("COMPLETED", 15)
snap("17-stop-completed")
click_text("Final delivery")
wait_for("DELIVERED", 15)
snap("18-delivered")

ws.close()
print(f"done: {shot} screenshots in {OUT}")
