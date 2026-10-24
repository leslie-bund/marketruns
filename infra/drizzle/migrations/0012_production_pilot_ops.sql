ALTER TABLE "markets" ADD COLUMN "config" jsonb DEFAULT '{}'::jsonb NOT NULL;
ALTER TABLE "markets" ADD COLUMN "active" boolean DEFAULT true NOT NULL;
ALTER TABLE "stores" ADD COLUMN "exchange_point" text DEFAULT '' NOT NULL;

CREATE TABLE "user" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "email" text NOT NULL UNIQUE,
  "email_verified" boolean DEFAULT false NOT NULL,
  "image" text,
  "role" text DEFAULT 'viewer' NOT NULL,
  "must_change_password" boolean DEFAULT true NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "ops_user_role_valid" CHECK ("role" IN ('viewer', 'operator', 'admin'))
);
CREATE TABLE "session" (
  "id" text PRIMARY KEY NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "token" text NOT NULL UNIQUE,
  "ip_address" text,
  "user_agent" text,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE cascade,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE TABLE "account" (
  "id" text PRIMARY KEY NOT NULL,
  "account_id" text NOT NULL,
  "provider_id" text NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE cascade,
  "access_token" text,
  "refresh_token" text,
  "id_token" text,
  "access_token_expires_at" timestamptz,
  "refresh_token_expires_at" timestamptz,
  "scope" text,
  "password" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE TABLE "verification" (
  "id" text PRIMARY KEY NOT NULL,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE TABLE "runner_pools" (
  "id" text PRIMARY KEY NOT NULL,
  "market_id" text NOT NULL REFERENCES "markets"("id"),
  "name" text NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "runner_pools_market_name_unique" ON "runner_pools" ("market_id", "name");
CREATE TABLE "runner_pool_memberships" (
  "pool_id" text NOT NULL REFERENCES "runner_pools"("id") ON DELETE cascade,
  "runner_id" text NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "runner_pool_membership_unique" ON "runner_pool_memberships" ("pool_id", "runner_id");
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
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX "ops_audit_created_at_idx" ON "ops_audit" ("created_at");
CREATE TABLE "do_telemetry" (
  "object_name" text PRIMARY KEY NOT NULL,
  "instance_id" text NOT NULL,
  "object_class" text NOT NULL,
  "market" text,
  "connection_count" integer DEFAULT 0 NOT NULL,
  "connections" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "last_activity_at" timestamptz NOT NULL,
  "alarm_at" timestamptz,
  "reported_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX "do_telemetry_reported_at_idx" ON "do_telemetry" ("reported_at");
