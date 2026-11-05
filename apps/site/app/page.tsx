import Link from "next/link";

const steps = [
  ["01", "Post an intent", "Tell nearby sellers what you need, the quantity, and the price band you have in mind."],
  ["02", "Choose your offers", "Receive live offers, negotiate privately, and accept what works before the intent expires."],
  ["03", "Follow one run", "A runner collects the whole cart and completes each handoff with QR and photo evidence."],
];

const audiences = [
  ["For buyers", "Your market list becomes one coordinated trip. No chasing different sellers or arranging separate deliveries."],
  ["For sellers", "Matching intents bring real demand to your store while it is live. Respond with an offer and keep selling."],
  ["For runners", "Collect a full cart on a sequenced trip, prove every handoff, and receive settlement when the run closes."],
];

export default function HomePage() {
  return (
    <>
      <section className="hero">
        <div className="hero-copy">
          <span className="eyebrow">Built for Nigerian markets</span>
          <h1>Everything you need.<br /><em>One market run.</em></h1>
          <p className="hero-lede">
            Post what you need, receive offers from local sellers, and let one runner bring the whole cart.
            Less coordination, fewer separate deliveries, more time for everything else.
          </p>
          <div className="hero-actions">
            <Link className="button" href="/register">Join early access</Link>
            <Link className="button secondary" href="/#how-it-works">See how it works</Link>
          </div>
          <p className="hero-note">Launching with selected markets and internal runners.</p>
        </div>
        <div className="run-card" aria-label="Example market run">
          <div className="run-card-head"><span>Live cart</span><span className="status-dot">Run in progress</span></div>
          <div className="run-line"><span className="run-icon">1</span><div><strong>Intent accepted</strong><p>Your items are gathered into one cart.</p></div></div>
          <div className="run-line active"><span className="run-icon">2</span><div><strong>Runner is collecting</strong><p>Store stops are sequenced into a single trip.</p></div></div>
          <div className="run-line"><span className="run-icon">3</span><div><strong>Verified handoff</strong><p>QR challenge and photo evidence at delivery.</p></div></div>
          <div className="run-total"><span>Separate errands avoided</span><strong>One run</strong></div>
        </div>
      </section>

      <section className="proof-strip" aria-label="Market Runs benefits">
        <span>Live seller offers</span><span>One coordinated trip</span><span>Verified handoffs</span><span>Settlement at close</span>
      </section>

      <section className="section" id="how-it-works">
        <span className="eyebrow">How it works</span>
        <h2>From your list to your doorstep.</h2>
        <p className="section-lede">Market Runs coordinates the moving parts so you do not have to.</p>
        <div className="steps-grid">
          {steps.map(([number, title, body]) => <article className="step-card" key={number}><span>{number}</span><h3>{title}</h3><p>{body}</p></article>)}
        </div>
      </section>

      <section className="section">
        <span className="eyebrow">One marketplace, three sides</span>
        <h2>Built to make every run worthwhile.</h2>
        <div className="audience-grid">
          {audiences.map(([title, body]) => <article className="audience-card" key={title}><h3>{title}</h3><p>{body}</p></article>)}
        </div>
      </section>

      <section className="trust-section">
        <div><span className="eyebrow">Trust is built into the trip</span><h2>Proof at every handoff.</h2></div>
        <p>Each exchange point uses a one-time QR challenge and photo evidence. Reputation comes from completed trips and real outcomes, not star ratings.</p>
      </section>

      <section className="cta-section">
        <span className="eyebrow">Be first in line</span>
        <h2>Your next market run can be simpler.</h2>
        <p>Register for launch updates and early onboarding in your area.</p>
        <Link className="button" href="/register">Register your interest</Link>
      </section>
    </>
  );
}
