import type { InboundEmailRow } from "./db.js";
import type { SiteEnv } from "./env.js";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const styles = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
         background: #0b0f0c; color: #e8f0e9; line-height: 1.6; }
  a { color: #4ade80; }
  .wrap { max-width: 880px; margin: 0 auto; padding: 2.5rem 1.25rem 4rem; }
  header.top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 3.5rem; }
  .brand { font-weight: 800; font-size: 1.25rem; letter-spacing: -0.02em; color: #e8f0e9; text-decoration: none; }
  .brand span { color: #4ade80; }
  nav a { margin-left: 1rem; text-decoration: none; font-size: 0.95rem; }
  .hero h1 { font-size: clamp(2.1rem, 5vw, 3.1rem); line-height: 1.08; letter-spacing: -0.03em; margin: 0 0 1.1rem; }
  .hero p.lede { font-size: 1.15rem; color: #a7b8ab; max-width: 38rem; }
  .pill { display: inline-block; padding: 0.2rem 0.7rem; border: 1px solid #234431; border-radius: 999px;
          color: #4ade80; font-size: 0.78rem; letter-spacing: 0.07em; text-transform: uppercase; margin-bottom: 1.25rem; }
  .card { background: #11171350; border: 1px solid #1e2b22; border-radius: 14px; padding: 1.4rem 1.5rem; margin: 1rem 0; }
  .card h3 { margin-top: 0; }
  .card p { color: #a7b8ab; margin-bottom: 0; }
  .grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); margin-top: 1.25rem; }
  h2.section { font-size: 1.6rem; letter-spacing: -0.02em; margin: 3.5rem 0 0.25rem; }
  p.section-lede { color: #a7b8ab; margin-top: 0; max-width: 40rem; }
  ol.steps { padding-left: 1.2rem; display: grid; gap: 1rem; margin-top: 1.5rem; }
  ol.steps li strong { color: #e8f0e9; }
  ol.steps li { color: #a7b8ab; }
  form { display: grid; gap: 0.9rem; max-width: 22rem; }
  label { font-size: 0.85rem; color: #a7b8ab; display: grid; gap: 0.35rem; }
  input { background: #0e1410; border: 1px solid #1e2b22; border-radius: 10px; color: #e8f0e9;
          padding: 0.65rem 0.8rem; font-size: 1rem; }
  input:focus { outline: 2px solid #4ade8055; border-color: #4ade80; }
  button, .btn { background: #4ade80; color: #07130b; border: 0; border-radius: 10px; padding: 0.7rem 1.1rem;
                 font-weight: 700; font-size: 1rem; cursor: pointer; text-decoration: none; display: inline-block; }
  .btn.secondary, button.secondary { background: transparent; color: #4ade80; border: 1px solid #234431; }
  .muted { color: #a7b8ab; font-size: 0.9rem; }
  .error { color: #f87171; font-size: 0.9rem; min-height: 1.2em; }
  .ok { color: #4ade80; font-size: 0.95rem; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 0.6rem 0.5rem; border-bottom: 1px solid #1e2b22; vertical-align: top; font-size: 0.92rem; }
  th { color: #a7b8ab; font-weight: 600; }
  details summary { cursor: pointer; color: #4ade80; }
  pre { background: #0e1410; border: 1px solid #1e2b22; border-radius: 10px; padding: 0.9rem;
        overflow-x: auto; font-size: 0.8rem; color: #a7b8ab; white-space: pre-wrap; word-break: break-word; }
  code.addr { background: #0e1410; border: 1px solid #234431; border-radius: 8px; padding: 0.15rem 0.5rem; color: #4ade80; }
  .cta { margin-top: 3.5rem; border: 1px solid #234431; border-radius: 16px; padding: 2rem; text-align: center;
         background: linear-gradient(180deg, #12201660, #0e1410); }
`;

function page(title: string, body: string, env: SiteEnv, signedIn: boolean): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="description" content="Market Runs — the on-demand errand marketplace for Nigeria. Post an intent, get ephemeral offers from local sellers, and one runner brings the whole cart in a single trip." />
<title>${escapeHtml(title)} · Market Runs</title>
<style>${styles}</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <a class="brand" href="/">market<span>·</span>runs</a>
    <nav>
      ${
        signedIn
          ? `<a href="/inbox">Inbox</a><a href="#" onclick="event.preventDefault();fetch('/api/auth/sign-out',{method:'POST'}).then(()=>location.href='/')">Sign out</a>`
          : `<a href="/sign-in">Admin sign in</a>`
      }
    </nav>
  </header>
  ${body}
  <footer class="muted" style="margin-top:4rem">Contact: <a href="mailto:${escapeHtml(env.inboundEmail)}"><code class="addr">${escapeHtml(env.inboundEmail)}</code></a></footer>
</div>
</body>
</html>`;
}

export function landingPage(env: SiteEnv, signedIn: boolean): string {
  const body = `
  <section class="hero">
    <div class="pill">On-demand errand marketplace · Nigeria</div>
    <h1>Post an intent.<br />One runner brings the whole cart.</h1>
    <p class="lede">Market Runs turns the markets locals already know — Balogun, Computer Village, the
       neighbourhood high street — into live, on-demand storefronts. A buyer posts what they need,
       sellers answer with offers that exist only while the intent is alive, and a single runner
       collects everything in one trip.</p>
  </section>

  <h2 class="section">How a run works</h2>
  <p class="section-lede">No catalogues to scroll, no carts that linger for weeks. Demand is expressed,
     answered, and delivered inside the market's own opening hours.</p>
  <ol class="steps">
    <li><strong>Post an intent.</strong> Say what you need — item, quantity, and your price band. The intent
        reaches only the stores whose shop items match, inside one named market.</li>
    <li><strong>Receive ephemeral offers.</strong> Sellers respond with offers that live only as long as your
        intent. Negotiate privately, one thread per offer — no auctions, no bidding wars, no audience.</li>
    <li><strong>Accept, and the cart starts its clock.</strong> Every acceptance extends a shared deadline, up to a
        hard ceiling, so the whole cart moves together or expires together.</li>
    <li><strong>One runner, one trip.</strong> A runner collects every item from its sellers and delivers to your
        door or a nearby muster point — guaranteed at the floor rate even when no outside runner bids.</li>
    <li><strong>Hand off with proof.</strong> Each exchange point is confirmed by a one-time QR challenge plus
        photo evidence. When the run closes, settlement releases payment to sellers and runner in one step.</li>
  </ol>

  <h2 class="section">Built for each side of the market</h2>
  <div class="grid">
    <div class="card"><h3>Buyers</h3><p>Ask for exactly what you want, at the price you expect. Offers come to you
      while your intent is live, and one tracked trip replaces five separate errands.</p></div>
    <div class="card"><h3>Sellers</h3><p>Your shop items are your reach. Matching intents arrive in real time;
      every offer you make is live only until accepted or expired — nothing stale, nothing to unpublish.</p></div>
    <div class="card"><h3>Runners</h3><p>Full carts, not fragments: every run is a complete trip with its stops
      sequenced, its handoffs witnessed, and its settlement paid at close.</p></div>
  </div>

  <h2 class="section">Trust without star ratings</h2>
  <p class="section-lede">Reputation is computed from what actually happened — completed trips, abort rates,
     dispute outcomes — never from user-entered reviews. Money moves only through the settlement function:
     completed, partial, aborted and disputed runs each follow explicit rules, and every handoff on the way
     carries photographic proof.</p>

  <section class="cta">
    <h2 style="margin-top:0">Talk to us</h2>
    <p class="muted" style="max-width:32rem;margin-left:auto;margin-right:auto">Launch market announcements,
       seller onboarding and partnerships — reach the team at</p>
    <p><a class="btn" href="mailto:${escapeHtml(env.inboundEmail)}">${escapeHtml(env.inboundEmail)}</a></p>
    ${signedIn ? `<p style="margin-bottom:0"><a class="btn secondary" href="/inbox">Open inbox</a></p>` : ""}
  </section>`;
  return page("Home", body, env, signedIn);
}

function authFormBody(): string {
  return `
  <h1>Admin sign in</h1>
  <p class="muted">Enter your email and we'll send you a magic link. Access is restricted to configured admin addresses.</p>
  <form id="f">
    <label>Email <input name="email" type="email" autocomplete="email" required /></label>
    <div class="error" id="err"></div>
    <div class="ok" id="ok"></div>
    <button type="submit">Email me a sign-in link</button>
  </form>
  <script>
    document.getElementById("f").addEventListener("submit", async (e) => {
      e.preventDefault();
      const err = document.getElementById("err");
      const ok = document.getElementById("ok");
      err.textContent = ""; ok.textContent = "";
      const data = Object.fromEntries(new FormData(e.target).entries());
      const res = await fetch("/api/auth/sign-in/magic-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: data.email, callbackURL: "/inbox" }),
      });
      if (res.ok) { ok.textContent = "If that address is an admin, a sign-in link is on its way — check your inbox."; return; }
      const body = await res.json().catch(() => ({}));
      err.textContent = body.message || "Something went wrong — please try again.";
    });
  </script>`;
}

export function signInPage(env: SiteEnv): string {
  return page("Sign in", authFormBody(), env, false);
}

export function forbiddenPage(env: SiteEnv, email: string): string {
  const body = `
  <h1>Not an admin</h1>
  <div class="card"><p><strong>${escapeHtml(email)}</strong> is not on the admin list for this site.
    The inbox is restricted to addresses configured in <code class="addr">ADMIN_EMAILS</code>.</p></div>
  <p><a href="/">Back to home</a></p>`;
  return page("Forbidden", body, env, true);
}

export function inboxPage(env: SiteEnv, emails: InboundEmailRow[], userEmail: string): string {
  const rows = emails
    .map((m) => {
      let to = m.to_addresses;
      try {
        const parsed: unknown = JSON.parse(m.to_addresses);
        if (Array.isArray(parsed)) to = parsed.join(", ");
      } catch {
        /* keep raw */
      }
      const detail = `
        ${m.text_body ? `<pre>${escapeHtml(m.text_body)}</pre>` : ""}
        ${!m.text_body && m.html_body ? `<pre>${escapeHtml(m.html_body)}</pre>` : ""}
        <details><summary>Raw webhook payload</summary><pre>${escapeHtml(m.raw_payload)}</pre></details>`;
      return `<tr>
        <td>${escapeHtml(new Date(m.received_at).toLocaleString("en-GB"))}</td>
        <td>${escapeHtml(m.from_address)}</td>
        <td>${escapeHtml(to)}</td>
        <td><details><summary>${escapeHtml(m.subject || "(no subject)")}</summary>${detail}</details></td>
      </tr>`;
    })
    .join("\n");
  const body = `
  <h1>Inbox</h1>
  <p class="muted">Signed in as ${escapeHtml(userEmail)} · mail received at
    <code class="addr">${escapeHtml(env.inboundEmail)}</code> via the Resend inbound webhook appears here.
    <a href="/inbox">Refresh</a></p>
  ${
    emails.length === 0
      ? `<div class="card"><p>No email received yet. Once the domain is linked in Resend and the webhook
         (<code class="addr">POST ${escapeHtml(env.baseUrl)}/api/webhooks/resend</code>) is subscribed to
         <em>email.received</em>, new mail shows up here.</p></div>`
      : `<table><thead><tr><th>Received</th><th>From</th><th>To</th><th>Subject</th></tr></thead><tbody>${rows}</tbody></table>`
  }`;
  return page("Inbox", body, env, true);
}
