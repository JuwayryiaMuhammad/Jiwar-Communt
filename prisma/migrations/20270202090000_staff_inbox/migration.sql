-- ============================================================================
-- The staff inbox (ADR 0073): one queue over what waits for a staff decision,
-- across the domains. The items stay in their own tables; the inbox keeps
-- only a compound's own due times and which overdue items it already told.
-- No personal data here.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- A compound's own due time for a type: hours from when an item starts
-- waiting to when it is overdue. No row: the code's default for the type.
-- ----------------------------------------------------------------------------
CREATE TABLE "staff_inbox_due_hours" (
    "tenant_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "hours" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "staff_inbox_due_hours_pkey" PRIMARY KEY ("tenant_id", "type")
);
ALTER TABLE "staff_inbox_due_hours" ADD CONSTRAINT "staff_inbox_due_hours_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "staff_inbox_due_hours" ADD CONSTRAINT "staff_inbox_due_hours_type"
  CHECK ("type" IN ('registration', 'identity_change', 'worker_engagement', 'vehicle',
    'booking', 'unit_permit', 'work_permit', 'field_exception', 'plan_request',
    'invoice_dispute', 'decision_appeal', 'management_request'));
ALTER TABLE "staff_inbox_due_hours" ADD CONSTRAINT "staff_inbox_due_hours_range"
  CHECK ("hours" BETWEEN 1 AND 720);

-- ----------------------------------------------------------------------------
-- An overdue item whose deciders were told (`staff_inbox.overdue`): once per
-- item, ever. The key makes two sweeps at once tell nobody twice. `item_id`
-- is the item's id in its own domain's table (no foreign key: the inbox
-- reads many tables). Kept: a decided item is simply never read again.
-- ----------------------------------------------------------------------------
CREATE TABLE "staff_inbox_overdue" (
    "tenant_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "item_id" UUID NOT NULL,
    "notified_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "staff_inbox_overdue_pkey" PRIMARY KEY ("tenant_id", "type", "item_id")
);
ALTER TABLE "staff_inbox_overdue" ADD CONSTRAINT "staff_inbox_overdue_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "staff_inbox_overdue" ADD CONSTRAINT "staff_inbox_overdue_type"
  CHECK ("type" IN ('registration', 'identity_change', 'worker_engagement', 'vehicle',
    'booking', 'unit_permit', 'work_permit', 'field_exception', 'plan_request',
    'invoice_dispute', 'decision_appeal', 'management_request'));

-- ----------------------------------------------------------------------------
-- Grants and RLS. Due times are set and cleared; told items only added.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "staff_inbox_due_hours", "staff_inbox_overdue" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "staff_inbox_due_hours" TO jiwar_app;
GRANT SELECT, INSERT ON "staff_inbox_overdue" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['staff_inbox_due_hours', 'staff_inbox_overdue'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
