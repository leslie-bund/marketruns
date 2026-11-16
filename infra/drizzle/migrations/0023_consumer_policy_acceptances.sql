CREATE TABLE "consumer_policy_acceptances" (
	"id" text PRIMARY KEY NOT NULL,
	"participant_id" text NOT NULL,
	"policy_version" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "consumer_policy_acceptance_version_unique" ON "consumer_policy_acceptances" USING btree ("participant_id","policy_version");--> statement-breakpoint
CREATE INDEX "consumer_policy_acceptance_participant_idx" ON "consumer_policy_acceptances" USING btree ("participant_id","accepted_at");