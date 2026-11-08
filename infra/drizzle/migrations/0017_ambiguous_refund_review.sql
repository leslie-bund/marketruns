ALTER TABLE "payment_refunds" DROP CONSTRAINT "payment_refunds_status_valid";--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_status_valid" CHECK ("payment_refunds"."status" IN ('pending', 'processing', 'completed', 'failed', 'refund-review', 'refund-manual'));--> statement-breakpoint
UPDATE "payment_refunds" AS r
SET "status" = 'refund-review', "updated_at" = NOW()
FROM "payment_holds" AS h
WHERE r."hold_id" = h."id"
  AND r."status" = 'failed'
  AND r."amount_kobo" < h."amount_kobo"
  AND (
    r."failure_reason" LIKE 'provider-unreachable%'
    OR r."failure_reason" LIKE 'provider-response-unparseable%'
    OR r."failure_reason" LIKE 'provider-response-missing-refund%'
    OR (r."failure_reason" LIKE 'reconciliation-%' AND r."failure_reason" NOT LIKE 'reconciliation-conflict%')
  );