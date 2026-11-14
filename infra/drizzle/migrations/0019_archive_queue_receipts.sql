CREATE TABLE "archive_queue_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"request_id" text,
	"error" text,
	"first_received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "archive_queue_messages_status_valid" CHECK ("archive_queue_messages"."status" IN ('received', 'persisted', 'retrying', 'rejected')),
	CONSTRAINT "archive_queue_messages_attempts_positive" CHECK ("archive_queue_messages"."attempts" > 0)
);
--> statement-breakpoint
CREATE INDEX "archive_queue_messages_status_idx" ON "archive_queue_messages" USING btree ("status");
--> statement-breakpoint
CREATE INDEX "archive_queue_messages_updated_at_idx" ON "archive_queue_messages" USING btree ("updated_at");
