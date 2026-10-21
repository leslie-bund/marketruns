ALTER TABLE "archived_products" DROP CONSTRAINT "archived_products_store_id_stores_id_fk";
--> statement-breakpoint
ALTER TABLE "archived_products" DROP CONSTRAINT "archived_products_market_id_markets_id_fk";
--> statement-breakpoint
ALTER TABLE "runs_archive" DROP CONSTRAINT "runs_archive_market_id_markets_id_fk";
--> statement-breakpoint
ALTER TABLE "archived_products" ALTER COLUMN "buyer_id" DROP NOT NULL;