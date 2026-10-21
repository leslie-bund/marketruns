CREATE TABLE "face_auth_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_job_id" text NOT NULL,
	"participant_id" text NOT NULL,
	"role" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"failure_reason" text,
	"session_token_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "face_auth_jobs_kind_valid" CHECK ("face_auth_jobs"."kind" IN ('enrollment', 'authentication')),
	CONSTRAINT "face_auth_jobs_status_valid" CHECK ("face_auth_jobs"."status" IN ('pending', 'passed', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "face_enrollments" ALTER COLUMN "embedding_encrypted" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "face_enrollments" ALTER COLUMN "iv" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "face_enrollments" ALTER COLUMN "auth_tag" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "face_enrollments" ADD COLUMN "provider_ref" text;--> statement-breakpoint
CREATE UNIQUE INDEX "face_auth_jobs_provider_job_id_unique" ON "face_auth_jobs" USING btree ("provider_job_id");--> statement-breakpoint
CREATE INDEX "face_auth_jobs_participant_id_idx" ON "face_auth_jobs" USING btree ("participant_id");--> statement-breakpoint
CREATE INDEX "face_auth_jobs_status_idx" ON "face_auth_jobs" USING btree ("status");