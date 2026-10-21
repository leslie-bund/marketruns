CREATE TABLE "live_runs" (
	"run_id" text PRIMARY KEY NOT NULL,
	"market" text NOT NULL,
	"status" text NOT NULL,
	"runner_id" text,
	"buyer_id" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"retired_at" timestamp with time zone,
	"stop_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "live_runs_status_valid" CHECK ("live_runs"."status" IN ('assigned', 'collecting', 'delivering', 'delivered', 'closed', 'aborted')),
	CONSTRAINT "live_runs_stop_count_nonnegative" CHECK ("live_runs"."stop_count" >= 0)
);
--> statement-breakpoint
CREATE INDEX "live_runs_market_idx" ON "live_runs" USING btree ("market");--> statement-breakpoint
CREATE INDEX "live_runs_status_idx" ON "live_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "live_runs_retired_at_idx" ON "live_runs" USING btree ("retired_at");