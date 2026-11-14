CREATE TABLE "retained_media" (
	"id" text PRIMARY KEY NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"capture_ref" text NOT NULL,
	"object_key" text NOT NULL,
	"media_kind" text NOT NULL,
	"owner_id" text,
	"cart_id" text,
	"run_id" text,
	"status" text DEFAULT 'retained' NOT NULL,
	"retired_at" timestamp with time zone NOT NULL,
	"delete_after" timestamp with time zone NOT NULL,
	"hold_reason" text,
	"held_by" text,
	"held_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "retained_media_capture_ref_unique" UNIQUE("capture_ref"),
	CONSTRAINT "retained_media_subject_valid" CHECK ("retained_media"."subject_type" IN ('product', 'intent')),
	CONSTRAINT "retained_media_kind_valid" CHECK ("retained_media"."media_kind" IN ('image', 'video')),
	CONSTRAINT "retained_media_status_valid" CHECK ("retained_media"."status" IN ('retained', 'held', 'deleting', 'deleted'))
);
--> statement-breakpoint
CREATE INDEX "retained_media_subject_idx" ON "retained_media" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "retained_media_cart_id_idx" ON "retained_media" USING btree ("cart_id");--> statement-breakpoint
CREATE INDEX "retained_media_run_id_idx" ON "retained_media" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "retained_media_cleanup_idx" ON "retained_media" USING btree ("status","delete_after");