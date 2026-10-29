-- ============================================================================
-- Asset economics and the maintenance KPIs (ADR 0065) are computed on
-- read from the tickets, their costs and the plans' occurrences; nothing
-- is stored but the one rule the compound sets: an asset past its expected
-- life is advised for replacement once a year's repairs cost this share of
-- its replacement cost (50 % unless set). The default fills every existing
-- compound's row; no row is written.
-- ============================================================================

ALTER TABLE "maintenance_settings" ADD COLUMN "replace_cost_share_pct" INTEGER NOT NULL DEFAULT 50;
ALTER TABLE "maintenance_settings" ADD CONSTRAINT "maintenance_settings_replace_share_range"
  CHECK ("replace_cost_share_pct" BETWEEN 1 AND 100);

-- What the compound spent over a period, newest first.
CREATE INDEX "ticket_cost_entries_spend_idx" ON "ticket_cost_entries"("tenant_id", "entered_at")
  WHERE "voided_at" IS NULL;
