ALTER TABLE "face_enrollments" ADD COLUMN "capture_object_key" text;--> statement-breakpoint
ALTER TABLE "face_enrollments" ADD COLUMN "capture_sha256" text;--> statement-breakpoint
ALTER TABLE "face_enrollments" ADD COLUMN "capture_consent_version" text;--> statement-breakpoint
ALTER TABLE "face_enrollments" ADD COLUMN "capture_consent_granted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "face_enrollments" ADD COLUMN "capture_retained_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "face_auth_jobs" ADD COLUMN "pending_capture_object_key" text;--> statement-breakpoint
ALTER TABLE "face_auth_jobs" ADD COLUMN "pending_capture_sha256" text;--> statement-breakpoint
ALTER TABLE "face_auth_jobs" ADD COLUMN "pending_capture_consent_version" text;--> statement-breakpoint
ALTER TABLE "face_auth_jobs" ADD COLUMN "pending_capture_consent_granted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "face_enrollments" ADD CONSTRAINT "face_enrollments_capture_sha256_valid" CHECK ("capture_sha256" IS NULL OR "capture_sha256" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "face_auth_jobs" ADD CONSTRAINT "face_auth_jobs_pending_capture_sha256_valid" CHECK ("pending_capture_sha256" IS NULL OR "pending_capture_sha256" ~ '^[0-9a-f]{64}$');
