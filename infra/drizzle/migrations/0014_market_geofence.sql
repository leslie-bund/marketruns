ALTER TABLE "markets" ADD COLUMN "center_latitude" double precision;--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "center_longitude" double precision;--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "geofence_radius_meters" integer DEFAULT 750 NOT NULL;--> statement-breakpoint
ALTER TABLE "seller_presence" ADD COLUMN "latitude" double precision;--> statement-breakpoint
ALTER TABLE "seller_presence" ADD COLUMN "longitude" double precision;--> statement-breakpoint
ALTER TABLE "seller_presence" ADD COLUMN "accuracy_meters" double precision;--> statement-breakpoint
ALTER TABLE "seller_presence" ADD COLUMN "location_observed_at" timestamp with time zone;--> statement-breakpoint
UPDATE "markets" SET "center_latitude" = 6.4541, "center_longitude" = 3.3947, "geofence_radius_meters" = 750 WHERE "id" = 'Balogun';--> statement-breakpoint
UPDATE "markets" SET "center_latitude" = 6.5186, "center_longitude" = 3.3750, "geofence_radius_meters" = 750 WHERE "id" = 'Computer Village';--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "markets_geofence_center_complete" CHECK (("center_latitude" IS NULL AND "center_longitude" IS NULL) OR ("center_latitude" IS NOT NULL AND "center_longitude" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "markets_geofence_radius_positive" CHECK ("geofence_radius_meters" > 0);--> statement-breakpoint
ALTER TABLE "seller_presence" ADD CONSTRAINT "seller_presence_location_complete" CHECK (("latitude" IS NULL AND "longitude" IS NULL AND "accuracy_meters" IS NULL AND "location_observed_at" IS NULL) OR ("latitude" IS NOT NULL AND "longitude" IS NOT NULL AND "accuracy_meters" IS NOT NULL AND "location_observed_at" IS NOT NULL));
