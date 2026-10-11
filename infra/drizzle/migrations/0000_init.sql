CREATE TABLE "archived_products" (
	"id" text PRIMARY KEY NOT NULL,
	"intent_id" text NOT NULL,
	"cart_id" text,
	"store_id" text NOT NULL,
	"market_id" text NOT NULL,
	"buyer_id" text NOT NULL,
	"final_price_kobo" bigint NOT NULL,
	"quantity" integer NOT NULL,
	"retirement_reason" text NOT NULL,
	"final_state" jsonb NOT NULL,
	"retired_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "archived_products_final_price_nonnegative" CHECK ("archived_products"."final_price_kobo" >= 0),
	CONSTRAINT "archived_products_quantity_positive" CHECK ("archived_products"."quantity" > 0),
	CONSTRAINT "archived_products_retirement_reason_valid" CHECK ("archived_products"."retirement_reason" IN ('accepted', 'expired', 'withdrawn', 'cart_expired'))
);
--> statement-breakpoint
CREATE TABLE "disputes" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"settlement_record_id" text,
	"raised_by_participant_id" text NOT NULL,
	"evidence_refs" text[] DEFAULT '{}'::text[] NOT NULL,
	"ambiguous" boolean DEFAULT false NOT NULL,
	"absorbed_loss_kobo" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "disputes_status_valid" CHECK ("disputes"."status" IN ('open', 'under_review', 'resolved')),
	CONSTRAINT "disputes_absorbed_loss_nonnegative" CHECK ("disputes"."absorbed_loss_kobo" >= 0)
);
--> statement-breakpoint
CREATE TABLE "kyc_records" (
	"id" text PRIMARY KEY NOT NULL,
	"participant_id" text NOT NULL,
	"role" text NOT NULL,
	"status" text NOT NULL,
	"verification_id" text,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kyc_records_role_valid" CHECK ("kyc_records"."role" IN ('Buyer', 'Seller', 'Runner')),
	CONSTRAINT "kyc_records_status_valid" CHECK ("kyc_records"."status" IN ('pending', 'verified', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"settlement_record_id" text NOT NULL,
	"account" text NOT NULL,
	"party_id" text,
	"debit_kobo" bigint DEFAULT 0 NOT NULL,
	"credit_kobo" bigint DEFAULT 0 NOT NULL,
	"memo" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_single_sided" CHECK (("ledger_entries"."debit_kobo" > 0) <> ("ledger_entries"."credit_kobo" > 0)),
	CONSTRAINT "ledger_entries_directions_nonnegative" CHECK ("ledger_entries"."debit_kobo" >= 0 AND "ledger_entries"."credit_kobo" >= 0)
);
--> statement-breakpoint
CREATE TABLE "markets" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"opens_at" time NOT NULL,
	"closes_at" time NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "markets_name_unique" UNIQUE("name"),
	CONSTRAINT "markets_opens_before_closes" CHECK ("markets"."opens_at" < "markets"."closes_at")
);
--> statement-breakpoint
CREATE TABLE "runs_archive" (
	"id" text PRIMARY KEY NOT NULL,
	"cart_id" text NOT NULL,
	"market_id" text NOT NULL,
	"buyer_id" text NOT NULL,
	"runner_id" text NOT NULL,
	"status" text NOT NULL,
	"delivery" jsonb NOT NULL,
	"floor_rate_kobo" bigint NOT NULL,
	"started_at" timestamp with time zone,
	"final_delivery_at" timestamp with time zone,
	"closed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runs_archive_status_valid" CHECK ("runs_archive"."status" IN ('assigned', 'collecting', 'delivering', 'delivered', 'closed', 'aborted')),
	CONSTRAINT "runs_archive_floor_rate_nonnegative" CHECK ("runs_archive"."floor_rate_kobo" >= 0)
);
--> statement-breakpoint
CREATE TABLE "settlement_records" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"mode" text NOT NULL,
	"goods_total_kobo" bigint NOT NULL,
	"runner_kobo" bigint NOT NULL,
	"platform_kobo" bigint NOT NULL,
	"buyer_refund_kobo" bigint NOT NULL,
	"platform_loss_kobo" bigint NOT NULL,
	"inputs" jsonb NOT NULL,
	"outcome" jsonb NOT NULL,
	"released_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settlement_records_mode_valid" CHECK ("settlement_records"."mode" IN ('completed', 'aborted', 'disputed')),
	CONSTRAINT "settlement_records_amounts_nonnegative" CHECK ("settlement_records"."goods_total_kobo" >= 0 AND "settlement_records"."runner_kobo" >= 0 AND "settlement_records"."platform_kobo" >= 0 AND "settlement_records"."buyer_refund_kobo" >= 0 AND "settlement_records"."platform_loss_kobo" >= 0)
);
--> statement-breakpoint
CREATE TABLE "shop_items" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"name" text NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stores" (
	"id" text PRIMARY KEY NOT NULL,
	"seller_id" text NOT NULL,
	"market_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "archived_products" ADD CONSTRAINT "archived_products_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archived_products" ADD CONSTRAINT "archived_products_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_run_id_runs_archive_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs_archive"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_settlement_record_id_settlement_records_id_fk" FOREIGN KEY ("settlement_record_id") REFERENCES "public"."settlement_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_settlement_record_id_settlement_records_id_fk" FOREIGN KEY ("settlement_record_id") REFERENCES "public"."settlement_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs_archive" ADD CONSTRAINT "runs_archive_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_records" ADD CONSTRAINT "settlement_records_run_id_runs_archive_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs_archive"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_items" ADD CONSTRAINT "shop_items_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "archived_products_store_id_idx" ON "archived_products" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "archived_products_market_id_idx" ON "archived_products" USING btree ("market_id");--> statement-breakpoint
CREATE INDEX "archived_products_retired_at_idx" ON "archived_products" USING btree ("retired_at");--> statement-breakpoint
CREATE INDEX "disputes_run_id_idx" ON "disputes" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "disputes_status_idx" ON "disputes" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "kyc_records_participant_role_unique" ON "kyc_records" USING btree ("participant_id","role");--> statement-breakpoint
CREATE INDEX "kyc_records_participant_id_idx" ON "kyc_records" USING btree ("participant_id");--> statement-breakpoint
CREATE INDEX "kyc_records_status_idx" ON "kyc_records" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ledger_entries_settlement_record_id_idx" ON "ledger_entries" USING btree ("settlement_record_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_account_party_id_idx" ON "ledger_entries" USING btree ("account","party_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_created_at_idx" ON "ledger_entries" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "runs_archive_market_id_idx" ON "runs_archive" USING btree ("market_id");--> statement-breakpoint
CREATE INDEX "runs_archive_buyer_id_idx" ON "runs_archive" USING btree ("buyer_id");--> statement-breakpoint
CREATE INDEX "runs_archive_runner_id_idx" ON "runs_archive" USING btree ("runner_id");--> statement-breakpoint
CREATE INDEX "runs_archive_status_idx" ON "runs_archive" USING btree ("status");--> statement-breakpoint
CREATE INDEX "runs_archive_closed_at_idx" ON "runs_archive" USING btree ("closed_at");--> statement-breakpoint
CREATE INDEX "settlement_records_run_id_idx" ON "settlement_records" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "settlement_records_mode_idx" ON "settlement_records" USING btree ("mode");--> statement-breakpoint
CREATE INDEX "settlement_records_created_at_idx" ON "settlement_records" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "shop_items_store_id_idx" ON "shop_items" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "stores_market_id_idx" ON "stores" USING btree ("market_id");--> statement-breakpoint
CREATE INDEX "stores_seller_id_idx" ON "stores" USING btree ("seller_id");