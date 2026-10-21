CREATE TABLE "payment_dispatches" (
	"id" text PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"settlement_record_id" text NOT NULL,
	"run_id" text NOT NULL,
	"market" text NOT NULL,
	"account" text NOT NULL,
	"party_id" text NOT NULL,
	"amount_kobo" bigint NOT NULL,
	"memo" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"provider_ref" text,
	"failure_reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_dispatches_account_valid" CHECK ("payment_dispatches"."account" IN ('seller', 'runner', 'platform')),
	CONSTRAINT "payment_dispatches_status_valid" CHECK ("payment_dispatches"."status" IN ('pending', 'sent', 'queued', 'failed')),
	CONSTRAINT "payment_dispatches_amount_nonnegative" CHECK ("payment_dispatches"."amount_kobo" >= 0),
	CONSTRAINT "payment_dispatches_attempts_nonnegative" CHECK ("payment_dispatches"."attempts" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_dispatches_idempotency_key_unique" ON "payment_dispatches" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "payment_dispatches_run_id_idx" ON "payment_dispatches" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "payment_dispatches_settlement_record_id_idx" ON "payment_dispatches" USING btree ("settlement_record_id");--> statement-breakpoint
CREATE INDEX "payment_dispatches_status_idx" ON "payment_dispatches" USING btree ("status");