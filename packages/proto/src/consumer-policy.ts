import { z } from "zod";
import { TimestampSchema } from "./primitives.js";

/** A version is immutable: any wording change requires a new version and fresh acknowledgement. */
export const CONSUMER_POLICY_VERSION = "consumer-refund-v1";

export const CONSUMER_POLICY = {
  title: "Consumer, returns and refund policy",
  version: CONSUMER_POLICY_VERSION,
  effectiveDate: "16 November 2026",
  sections: [
    {
      title: "Who supplies your order",
      body: "The Seller supplies the goods shown in an accepted Product. Market Runs provides the marketplace and arranges the Run; the Runner collects and delivers the goods. Your receipt identifies the accepted items, prices, delivery charge and total. Contact Market Runs about a problem with the goods, payment or delivery rather than relying only on a Seller or Runner to resolve it.",
    },
    {
      title: "Prices, descriptions and changes",
      body: "You pay the final accepted goods price plus the displayed delivery charge and any disclosed mandatory charge, in naira. A Seller must describe the actual item honestly, including its condition. A changed item, quantity or price needs your fresh acceptance; it is not silently substituted.",
    },
    {
      title: "Cancellation before completion",
      body: "You may ask to cancel an advance order. Any cancellation charge must be reasonable for the work and costs already incurred and the chance of redeploying the Run. No cancellation fee applies where death or hospitalisation prevents you from honouring the booking. Money already captured is returned through the applicable settlement and refund process.",
    },
    {
      title: "Fast dispute window and your continuing rights",
      body: "Report a missing, damaged, substituted or incorrect item promptly from your Run, with any available evidence. The 30-minute in-app dispute window pauses automatic settlement so the team can review the evidence quickly. It is not a deadline that removes your statutory rights. You can still contact Market Runs after it closes, and later complaints receive a separate review.",
    },
    {
      title: "Faulty, unsuitable or misdescribed goods",
      body: "Your rights under the Federal Competition and Consumer Protection Act continue to apply. These include remedies for unsafe, defective, unsuitable or misdescribed goods and for services not performed with reasonable care and skill. In particular, the Act provides a three-month return right after delivery for goods that fail its quality standards, without a return penalty and at the supplying undertaking's risk and expense. The required remedy may be repair, replacement or refund. No perishable-goods label, receipt term or internal settlement rule removes a mandatory remedy.",
    },
    {
      title: "Failed, partial or aborted Runs",
      body: "A failed Seller stop, non-delivery, damage or Runner service failure is reviewed on its evidence. Market Runs' normal abort allocation may account for completed stops and reasonable disruption costs, but it does not limit a refund or other remedy that the law requires. Where the law requires a full refund, that legal outcome takes priority over the internal partial-abort rule.",
    },
    {
      title: "How refunds are returned",
      body: "Refunds are decided through the settlement process. Card refunds are sent back through the payment provider where supported. If the original payment method cannot receive an automatic refund, Market Runs records a manual refund process and confirms the destination with you. Conflicting provider history is reviewed before any retry to prevent a duplicate refund. A refund decision and the provider's completion of that refund are separate events.",
    },
    {
      title: "Complaints, review and escalation",
      body: "Use the dispute action on an active Run for urgent delivery problems. For any consumer or refund complaint, including one after the fast dispute window, email info@updates.marketruns.org with your receipt or Run reference. Do not send your BVN, NIN, card number, password or face image. You may ask for a human review of the outcome. You may also complain to the Federal Competition and Consumer Protection Commission or approach a competent court; using our complaint process is not a precondition to those rights.",
    },
    {
      title: "Seller and Runner responsibilities",
      body: "Sellers must cooperate with accurate-description, safety, return and refund reviews. Runners must preserve the chain of custody and cooperate with non-delivery, damage and incident reviews. A platform decision or settlement is not a criminal finding. These duties do not transfer a Buyer's statutory rights into an internal dispute between participants.",
    },
  ],
  fccpcUrl: "https://fccpc.gov.ng/consumers/complaint-handling/",
} as const;

export const ConsumerPolicyAcceptanceRequestSchema = z.object({
  policyVersion: z.string().min(1).max(120),
}).strict();

export const ConsumerPolicyAcceptanceSchema = z.object({
  participantId: z.string().min(1),
  policyVersion: z.string().min(1),
  acceptedAt: TimestampSchema,
});
export type ConsumerPolicyAcceptance = z.infer<typeof ConsumerPolicyAcceptanceSchema>;
