CREATE TABLE "payment_holds" (
	"id" text PRIMARY KEY NOT NULL,
	"tx_ref" text NOT NULL,
	"provider_tx_id" text NOT NULL,
	"cart_id" text NOT NULL,
	"run_id" text,
	"buyer_id" text NOT NULL,
	"amount_kobo" bigint NOT NULL,
	"payment_method" text NOT NULL,
	"status" text DEFAULT 'held' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_holds_status_valid" CHECK ("payment_holds"."status" IN ('held', 'released', 'partially-refunded', 'refunded', 'failed')),
	CONSTRAINT "payment_holds_amount_nonnegative" CHECK ("payment_holds"."amount_kobo" >= 0)
);
--> statement-breakpoint
CREATE TABLE "payment_refunds" (
	"id" text PRIMARY KEY NOT NULL,
	"hold_id" text NOT NULL,
	"settlement_record_id" text NOT NULL,
	"amount_kobo" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"provider_ref" text,
	"failure_reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_refunds_status_valid" CHECK ("payment_refunds"."status" IN ('pending', 'processing', 'completed', 'failed', 'refund-manual')),
	CONSTRAINT "payment_refunds_amount_positive" CHECK ("payment_refunds"."amount_kobo" > 0),
	CONSTRAINT "payment_refunds_attempts_nonnegative" CHECK ("payment_refunds"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "payout_accounts" (
	"participant_id" text PRIMARY KEY NOT NULL,
	"bank_code" text NOT NULL,
	"account_number" text NOT NULL,
	"account_name" text NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_holds_tx_ref_unique" ON "payment_holds" USING btree ("tx_ref");--> statement-breakpoint
CREATE INDEX "payment_holds_run_id_idx" ON "payment_holds" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "payment_holds_buyer_id_idx" ON "payment_holds" USING btree ("buyer_id");--> statement-breakpoint
CREATE INDEX "payment_holds_status_idx" ON "payment_holds" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_refunds_settlement_record_unique" ON "payment_refunds" USING btree ("settlement_record_id");--> statement-breakpoint
CREATE INDEX "payment_refunds_hold_id_idx" ON "payment_refunds" USING btree ("hold_id");--> statement-breakpoint
CREATE INDEX "payment_refunds_status_idx" ON "payment_refunds" USING btree ("status");