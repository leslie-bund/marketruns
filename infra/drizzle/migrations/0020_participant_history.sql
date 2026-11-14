ALTER TABLE "archived_products" ADD COLUMN "seller_participant_id" text;
--> statement-breakpoint
CREATE INDEX "archived_products_seller_participant_id_idx" ON "archived_products" USING btree ("seller_participant_id");
--> statement-breakpoint
CREATE TABLE "carts_archive" (
	"id" text PRIMARY KEY NOT NULL,
	"cart_id" text NOT NULL,
	"market_id" text NOT NULL,
	"buyer_id" text NOT NULL,
	"reason" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"retired_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "carts_archive_reason_valid" CHECK ("carts_archive"."reason" IN ('deadline-expired', 'checked-out', 'aborted'))
);
--> statement-breakpoint
CREATE INDEX "carts_archive_buyer_id_idx" ON "carts_archive" USING btree ("buyer_id");
--> statement-breakpoint
CREATE INDEX "carts_archive_cart_id_idx" ON "carts_archive" USING btree ("cart_id");
--> statement-breakpoint
CREATE INDEX "carts_archive_retired_at_idx" ON "carts_archive" USING btree ("retired_at");
