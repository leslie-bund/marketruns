import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import RootLayout from "../app/layout";
import PrivacyPage, { metadata } from "../app/privacy/page";
import { RegistrationForm } from "../components/registration-form";

const privacyHtml = renderToStaticMarkup(createElement(PrivacyPage));
const notice = readFileSync(new URL("../../../docs/privacy-notice.md", import.meta.url), "utf8");

function renderLayout(path: string) {
  return renderToStaticMarkup(createElement(RootLayout, {
    children: createElement("a", { href: path }, "Page"),
  }));
}

describe("privacy notice", () => {
  it("publishes the canonical route and verified publication details", () => {
    expect(metadata.alternates).toEqual({ canonical: "https://www.marketruns.org/privacy" });
    for (const detail of ["14 November 2026", "privacy-notice-v2", "Allegados Limited", "info@updates.marketruns.org"]) {
      expect(privacyHtml).toContain(detail);
      expect(notice).toContain(detail);
    }
    expect(privacyHtml).toContain('href="https://ndpc.gov.ng/contact/"');
    expect(privacyHtml).toContain("interest</strong> (buyer");
    expect(privacyHtml).toContain("concern to <a");
    expect(privacyHtml).not.toContain("interest</strong>(buyer");
    expect(privacyHtml).not.toContain("concern to<a");
    expect(notice).toContain("https://ndpc.gov.ng/contact/");
  });

  it("describes the implemented biometric, location, deletion, and eligibility behavior", () => {
    for (const claim of [
      "ArcFace",
      "1:1",
      "transit-only",
      "seven days",
      "90 days after run close",
      "one current enrollment selfie",
      "promptly deleted",
      "foreground-only",
      "static floor-rate estimates",
      "manual request and process",
      "do not promise immediate erasure",
      "18 or older",
      "not visible to other participants by default",
    ]) {
      expect(privacyHtml).toContain(claim);
      expect(notice).toContain(claim);
    }
    expect(privacyHtml).not.toContain("SFace");
    expect(notice).not.toContain("SFace");
  });

  it("names the current service providers without placeholder or invented publication fields", () => {
    for (const provider of ["Cloudflare", "Neon", "Smile ID", "Flutterwave", "Resend", "Vercel", "Render", "Google Maps", "Apple Maps"]) {
      expect(privacyHtml).toContain(provider);
      expect(notice).toContain(provider);
    }
    for (const unfinished of ["OWNER INPUT", "DRAFT FOR OWNER REVIEW", "market-runs.example", "SFace"]) {
      expect(privacyHtml).not.toContain(unfinished);
      expect(notice).not.toContain(unfinished);
    }
  });
});

describe("privacy navigation and registration consent", () => {
  it.each(["/", "/register"])("adds the privacy link and verified contact to the %s footer", () => {
    const footer = renderLayout("/");
    expect(footer).toContain('href="/privacy"');
    expect(footer).toContain(">Privacy</a>");
    expect(footer).toContain('href="mailto:info@updates.marketruns.org"');
  });

  it("links the registration form to privacy and offers email opt-out without claiming an unsubscribe workflow", () => {
    const form = renderToStaticMarkup(createElement(RegistrationForm));
    expect(form).toContain("I agree to receive Market Runs launch and onboarding emails.");
    expect(form).toContain('href="/privacy"');
    expect(form).toContain('href="mailto:info@updates.marketruns.org"');
    expect(form).toContain("You can opt out at any time by emailing");
    expect(form).not.toContain("I can unsubscribe at any time");
  });
});
