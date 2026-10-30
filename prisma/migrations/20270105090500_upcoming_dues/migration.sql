-- ============================================================================
-- R11c-1a (ADR 0069): what a unit will owe, and a notice when it rises.
--
-- The forecast is computed when asked and stored nowhere. Only its notice
-- is kept: when the compound turns it on, a unit whose next month asks
-- more than one and a half times the months before is told once that
-- month — the (unit, month) row, claimed before the notice is written.
-- ============================================================================

ALTER TABLE "finance_settings" ADD COLUMN "dues_notice" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "finance_dues_notices" (
    "tenant_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "month" TEXT NOT NULL,
    "told_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    CONSTRAINT "finance_dues_notices_pkey" PRIMARY KEY ("tenant_id", "unit_id", "month")
);
ALTER TABLE "finance_dues_notices"
  ADD CONSTRAINT "finance_dues_notices_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_dues_notices_unit_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "finance_dues_notices" ADD CONSTRAINT "finance_dues_notices_month"
  CHECK ("month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');

CREATE TRIGGER finance_dues_notices_immutable
  BEFORE UPDATE OR DELETE ON "finance_dues_notices"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER finance_dues_notices_no_truncate
  BEFORE TRUNCATE ON "finance_dues_notices"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "finance_dues_notices" FROM jiwar_app;
GRANT SELECT, INSERT ON "finance_dues_notices" TO jiwar_app;
ALTER TABLE "finance_dues_notices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "finance_dues_notices" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "finance_dues_notices"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
