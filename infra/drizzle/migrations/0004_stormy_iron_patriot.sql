CREATE TABLE "auth_sessions" (
	"token_id" text PRIMARY KEY NOT NULL,
	"participant_id" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "device_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"participant_id" text NOT NULL,
	"credential_type" text NOT NULL,
	"public_key" text,
	"secret_hash" text,
	"device_label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "device_credentials_type_valid" CHECK ("device_credentials"."credential_type" IN ('fido', 'device-key'))
);
--> statement-breakpoint
CREATE TABLE "device_reset_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"participant_id" text NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	CONSTRAINT "device_reset_requests_status_valid" CHECK ("device_reset_requests"."status" IN ('pending', 'approved', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "face_auth_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"participant_id" text NOT NULL,
	"outcome" text NOT NULL,
	"similarity_bucket" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "face_auth_attempts_outcome_valid" CHECK ("face_auth_attempts"."outcome" IN ('pass', 'fail')),
	CONSTRAINT "face_auth_attempts_bucket_valid" CHECK ("face_auth_attempts"."similarity_bucket" IS NULL OR "face_auth_attempts"."similarity_bucket" IN ('low', 'medium', 'high'))
);
--> statement-breakpoint
CREATE TABLE "face_enrollments" (
	"participant_id" text PRIMARY KEY NOT NULL,
	"role" text NOT NULL,
	"embedding_encrypted" "bytea" NOT NULL,
	"iv" "bytea" NOT NULL,
	"auth_tag" "bytea" NOT NULL,
	"model_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_verified_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "auth_sessions_participant_id_idx" ON "auth_sessions" USING btree ("participant_id");--> statement-breakpoint
CREATE INDEX "auth_sessions_expires_at_idx" ON "auth_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "device_credentials_participant_type_unique" ON "device_credentials" USING btree ("participant_id","credential_type");--> statement-breakpoint
CREATE INDEX "device_credentials_participant_id_idx" ON "device_credentials" USING btree ("participant_id");--> statement-breakpoint
CREATE INDEX "device_reset_requests_participant_id_idx" ON "device_reset_requests" USING btree ("participant_id");--> statement-breakpoint
CREATE INDEX "device_reset_requests_status_idx" ON "device_reset_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "face_auth_attempts_participant_id_idx" ON "face_auth_attempts" USING btree ("participant_id");--> statement-breakpoint
CREATE INDEX "face_auth_attempts_created_at_idx" ON "face_auth_attempts" USING btree ("created_at");