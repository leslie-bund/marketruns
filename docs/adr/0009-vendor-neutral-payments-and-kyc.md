# Payments and KYC vendors sit behind internal abstractions

Bank-transfer-first payments and universal BVN-backed KYC are architecture; *which* provider executes them is procurement. Both the payment service provider (Paystack, Flutterwave, …) and the identity provider (Smile, Dojah, VerifyMe, …) are integrated behind internal abstractions, and neither vendor's name appears in the domain model. The reason is Nigeria-specific: PSP reliability and identity-vendor coverage genuinely fluctuate, and lock-in to either is an operational risk, not just an engineering smell.

## Consequences

- The domain model speaks in captures, holds, releases, and verifications — never in vendor API shapes.
- Switching or dual-homing a vendor is an integration-layer change, priced in days not quarters.
