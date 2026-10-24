CREATE TABLE "biometric_consent_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"participant_id" text NOT NULL,
	"purpose" text NOT NULL,
	"version" text NOT NULL,
	"granted_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "do_telemetry" (
	"object_name" text PRIMARY KEY NOT NULL,
	"instance_id" text NOT NULL,
	"object_class" text NOT NULL,
	"market" text,
	"connection_count" integer DEFAULT 0 NOT NULL,
	"connections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_activity_at" timestamp with time zone NOT NULL,
	"alarm_at" timestamp with time zone,
	"reported_at" timestamp with time zone DEFAULT now() NOT NULL
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
CREATE TABLE "notification_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"notification_id" text NOT NULL,
	"channel" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"provider_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_outbox_channel_valid" CHECK ("notification_outbox"."channel" IN ('websocket', 'email')),
	CONSTRAINT "notification_outbox_status_valid" CHECK ("notification_outbox"."status" IN ('pending', 'delivered', 'failed', 'skipped')),
	CONSTRAINT "notification_outbox_attempts_nonnegative" CHECK ("notification_outbox"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"recipient_id" text NOT NULL,
	"source_event_id" text NOT NULL,
	"source_event_type" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"category" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"deep_link" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	CONSTRAINT "notifications_category_valid" CHECK ("notifications"."category" IN ('marketplace', 'payment', 'security', 'system'))
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops_audit" (
	"id" text PRIMARY KEY NOT NULL,
	"operator_id" text NOT NULL,
	"operator_email" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"summary" text NOT NULL,
	"request_id" text,
	"outcome" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"role" text DEFAULT 'viewer' NOT NULL,
	"must_change_password" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email"),
	CONSTRAINT "ops_user_role_valid" CHECK ("user"."role" IN ('viewer', 'operator', 'admin'))
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "participant_profiles" (
	"participant_id" text PRIMARY KEY NOT NULL,
	"role" text NOT NULL,
	"email" text,
	"display_name" text NOT NULL,
	"verified_legal_name" text,
	"kyc_status" text NOT NULL,
	"id_document_type" text NOT NULL,
	"id_document_hash" text NOT NULL,
	"facial_capture_ref" text,
	"consent_at" timestamp with time zone,
	"consent_version" text,
	"markets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "participant_profiles_role_valid" CHECK ("participant_profiles"."role" IN ('buyer', 'seller', 'runner')),
	CONSTRAINT "participant_profiles_kyc_valid" CHECK ("participant_profiles"."kyc_status" IN ('pending', 'preverified', 'verified', 'failed')),
	CONSTRAINT "participant_profiles_document_valid" CHECK ("participant_profiles"."id_document_type" IN ('bvn', 'nin'))
);
--> statement-breakpoint
CREATE TABLE "runner_pool_memberships" (
	"pool_id" text NOT NULL,
	"runner_id" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runner_pools" (
	"id" text PRIMARY KEY NOT NULL,
	"market_id" text NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seller_presence" (
	"market_id" text NOT NULL,
	"participant_id" text NOT NULL,
	"store_id" text NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kyc_records" DROP CONSTRAINT "kyc_records_status_valid";--> statement-breakpoint
ALTER TABLE "live_runs" DROP CONSTRAINT "live_runs_status_valid";--> statement-breakpoint
ALTER TABLE "runs_archive" DROP CONSTRAINT "runs_archive_status_valid";--> statement-breakpoint
DROP INDEX "stores_seller_id_idx";--> statement-breakpoint
ALTER TABLE "face_auth_jobs" ADD COLUMN "pending_embedding_encrypted" "bytea";--> statement-breakpoint
ALTER TABLE "face_auth_jobs" ADD COLUMN "pending_embedding_iv" "bytea";--> statement-breakpoint
ALTER TABLE "face_auth_jobs" ADD COLUMN "pending_embedding_auth_tag" "bytea";--> statement-breakpoint
ALTER TABLE "face_auth_jobs" ADD COLUMN "pending_model_version" text;--> statement-breakpoint
ALTER TABLE "face_auth_jobs" ADD COLUMN "expires_at" timestamp with time zone NOT NULL;--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "config" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "exchange_point" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "shop_items" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "joined_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_pool_memberships" ADD CONSTRAINT "runner_pool_memberships_pool_id_runner_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."runner_pools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_pools" ADD CONSTRAINT "runner_pools_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_presence" ADD CONSTRAINT "seller_presence_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_presence" ADD CONSTRAINT "seller_presence_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "biometric_consent_participant_idx" ON "biometric_consent_receipts" USING btree ("participant_id");--> statement-breakpoint
CREATE INDEX "do_telemetry_reported_at_idx" ON "do_telemetry" USING btree ("reported_at");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_access_proofs_hash_unique" ON "identity_access_proofs" USING btree ("proof_hash");--> statement-breakpoint
CREATE INDEX "identity_access_proofs_participant_idx" ON "identity_access_proofs" USING btree ("participant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_outbox_notification_channel_unique" ON "notification_outbox" USING btree ("notification_id","channel");--> statement-breakpoint
CREATE INDEX "notification_outbox_delivery_idx" ON "notification_outbox" USING btree ("status","available_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_recipient_dedupe_unique" ON "notifications" USING btree ("recipient_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "notifications_recipient_created_idx" ON "notifications" USING btree ("recipient_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_recipient_read_idx" ON "notifications" USING btree ("recipient_id","read_at");--> statement-breakpoint
CREATE INDEX "notifications_source_event_idx" ON "notifications" USING btree ("source_event_id");--> statement-breakpoint
CREATE INDEX "ops_audit_created_at_idx" ON "ops_audit" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "participant_profiles_email_unique" ON "participant_profiles" USING btree ("email");--> statement-breakpoint
CREATE INDEX "participant_profiles_kyc_status_idx" ON "participant_profiles" USING btree ("kyc_status");--> statement-breakpoint
CREATE UNIQUE INDEX "runner_pool_membership_unique" ON "runner_pool_memberships" USING btree ("pool_id","runner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "runner_pools_market_name_unique" ON "runner_pools" USING btree ("market_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "seller_presence_participant_market_unique" ON "seller_presence" USING btree ("market_id","participant_id");--> statement-breakpoint
CREATE INDEX "seller_presence_last_seen_idx" ON "seller_presence" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "stores_seller_participant_id_idx" ON "stores" USING btree ("seller_id");--> statement-breakpoint
ALTER TABLE "kyc_records" ADD CONSTRAINT "kyc_records_status_valid" CHECK ("kyc_records"."status" IN ('pending', 'preverified', 'verified', 'failed'));--> statement-breakpoint
ALTER TABLE "live_runs" ADD CONSTRAINT "live_runs_status_valid" CHECK ("live_runs"."status" IN ('unassigned', 'assigned', 'collecting', 'delivering', 'delivered', 'closed', 'aborted'));--> statement-breakpoint
ALTER TABLE "runs_archive" ADD CONSTRAINT "runs_archive_status_valid" CHECK ("runs_archive"."status" IN ('unassigned', 'assigned', 'collecting', 'delivering', 'delivered', 'closed', 'aborted'));