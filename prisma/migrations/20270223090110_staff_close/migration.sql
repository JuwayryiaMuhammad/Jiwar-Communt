-- ============================================================================
-- Dispatch closes a resident's completed ticket on their behalf (ADR 0076):
-- they confirmed by phone, could not be reached, or left the compound. The
-- ticket is `closed` with `closed_by_staff` (the enum value of
-- 20270223090000), the reason code in its status history. So a closed ticket
-- is now confirmed, auto-closed or closed by the staff; the resident may
-- still reopen it within the compound's `reopenDays`.
-- ============================================================================

ALTER TABLE "tickets" DROP CONSTRAINT "tickets_closed_shape";
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_closed_shape"
  CHECK (("status" = 'closed') = ("confirmation_status" IS NOT DISTINCT FROM 'confirmed'
                                  OR "confirmation_status" IS NOT DISTINCT FROM 'auto_closed'
                                  OR "confirmation_status" IS NOT DISTINCT FROM 'closed_by_staff')
     AND ("status" = 'closed') = ("closed_at" IS NOT NULL));
