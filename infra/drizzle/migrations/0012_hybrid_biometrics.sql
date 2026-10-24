CREATE TABLE "biometric_consent_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"participant_id" text NOT NULL,
	"purpose" text NOT NULL,
	"version" text NOT NULL,
	"granted_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity_access_proofs" (
	"id" text PRIMARY KEY NOT NULL,
	"proof_hash" text NOT NULL,
	"participant_id" text NOT NULL,
	"purpose" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_access_proofs_purpose_valid" CHECK ("identity_access_proofs"."purpose" IN ('enrollment', 'recovery'))
);
--> statement-breakpoint
CREATE TABLE "identity_participants" (
	"participant_id" text PRIMARY KEY NOT NULL,
	"role" text NOT NULL,
	"kyc_status" text NOT NULL,
	"display_name" text NOT NULL,
	"verified_legal_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_participants_kyc_status_valid" CHECK ("identity_participants"."kyc_status" IN ('preverified', 'verified'))
);
--> statement-breakpoint
ALTER TABLE "face_auth_jobs" ADD COLUMN "pending_embedding_encrypted" "bytea";--> statement-breakpoint
ALTER TABLE "face_auth_jobs" ADD COLUMN "pending_embedding_iv" "bytea";--> statement-breakpoint
ALTER TABLE "face_auth_jobs" ADD COLUMN "pending_embedding_auth_tag" "bytea";--> statement-breakpoint
ALTER TABLE "face_auth_jobs" ADD COLUMN "pending_model_version" text;--> statement-breakpoint
ALTER TABLE "face_auth_jobs" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
UPDATE "face_auth_jobs" SET "expires_at" = "created_at" + interval '2 minutes';--> statement-breakpoint
ALTER TABLE "face_auth_jobs" ALTER COLUMN "expires_at" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "biometric_consent_participant_idx" ON "biometric_consent_receipts" USING btree ("participant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_access_proofs_hash_unique" ON "identity_access_proofs" USING btree ("proof_hash");--> statement-breakpoint
CREATE INDEX "identity_access_proofs_participant_idx" ON "identity_access_proofs" USING btree ("participant_id");