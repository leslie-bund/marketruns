CREATE TABLE "payment_refund_resolutions" (
	"refund_id" text PRIMARY KEY NOT NULL,
	"action" text NOT NULL,
	"status" text NOT NULL,
	"provider_ref" text,
	"evidence_ref" text NOT NULL,
	"note" text NOT NULL,
	"resolved_by" text NOT NULL,
	"resolved_at" timestamp with time zone NOT NULL,
	CONSTRAINT "payment_refund_resolutions_action_valid" CHECK ("payment_refund_resolutions"."action" IN ('accept-provider', 'complete-manual', 'allow-retry')),
	CONSTRAINT "payment_refund_resolutions_status_valid" CHECK ("payment_refund_resolutions"."status" IN ('processing', 'completed', 'failed')),
	CONSTRAINT "payment_refund_resolutions_action_shape" CHECK ((
        "payment_refund_resolutions"."action" = 'accept-provider'
        AND "payment_refund_resolutions"."status" IN ('processing', 'completed')
        AND "payment_refund_resolutions"."provider_ref" IS NOT NULL
      ) OR (
        "payment_refund_resolutions"."action" = 'complete-manual'
        AND "payment_refund_resolutions"."status" = 'completed'
        AND "payment_refund_resolutions"."provider_ref" IS NOT NULL
      ) OR (
        "payment_refund_resolutions"."action" = 'allow-retry'
        AND "payment_refund_resolutions"."status" = 'failed'
        AND "payment_refund_resolutions"."provider_ref" IS NULL
      )),
	CONSTRAINT "payment_refund_resolutions_evidence_valid" CHECK (btrim("payment_refund_resolutions"."evidence_ref") = "payment_refund_resolutions"."evidence_ref" AND char_length("payment_refund_resolutions"."evidence_ref") BETWEEN 1 AND 2048),
	CONSTRAINT "payment_refund_resolutions_note_valid" CHECK (btrim("payment_refund_resolutions"."note") = "payment_refund_resolutions"."note" AND char_length("payment_refund_resolutions"."note") BETWEEN 1 AND 2000),
	CONSTRAINT "payment_refund_resolutions_resolved_by_valid" CHECK (btrim("payment_refund_resolutions"."resolved_by") = "payment_refund_resolutions"."resolved_by" AND char_length("payment_refund_resolutions"."resolved_by") BETWEEN 1 AND 200),
	CONSTRAINT "payment_refund_resolutions_provider_ref_valid" CHECK ("payment_refund_resolutions"."provider_ref" IS NULL OR (btrim("payment_refund_resolutions"."provider_ref") = "payment_refund_resolutions"."provider_ref" AND char_length("payment_refund_resolutions"."provider_ref") BETWEEN 1 AND 255))
);
--> statement-breakpoint
ALTER TABLE "payment_refund_resolutions" ADD CONSTRAINT "payment_refund_resolutions_refund_id_payment_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."payment_refunds"("id") ON DELETE no action ON UPDATE no action;