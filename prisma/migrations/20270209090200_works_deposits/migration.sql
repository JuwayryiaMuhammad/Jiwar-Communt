-- ============================================================================
-- Fit-out completion (ADR 0074): a works permit's finishing-works deposit.
-- ============================================================================
--
-- A finishing-works deposit (ADR 0062) may name the works permit it is held
-- for: a works permit of the deposit's own unit, one deposit per permit. Two
-- composite keys hold it — the permit's kind (always works) and the
-- permit's unit — and a CHECK keeps a named permit to the finishing-works
-- kind. The deposit's row never changes (ADR 0062's trigger): the permit is
-- named when the deposit is recorded, or never.
--
-- The compound's permit rules gain `works_deposit_required`: on, a works
-- permit is approved only once a deposit named on it holds money. On by
-- default for a compound created from now on (the column's default); off
-- for every compound that exists when this runs (the owner, 2026-11-02),
-- written per tenant, so their works are approved as before until the
-- management turns it on.

ALTER TABLE "permit_settings"
  ADD COLUMN "works_deposit_required" BOOLEAN NOT NULL DEFAULT true;

DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    UPDATE "permit_settings" SET "works_deposit_required" = false
     WHERE "tenant_id" = t;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;

CREATE UNIQUE INDEX "unit_permits_tenant_id_id_unit_key"
  ON "unit_permits"("tenant_id", "id", "unit_id");

ALTER TABLE "finance_deposits" ADD COLUMN "permit_id" UUID;
ALTER TABLE "finance_deposits" ADD COLUMN "permit_kind" "unit_permit_kind";
CREATE UNIQUE INDEX "finance_deposits_permit_key"
  ON "finance_deposits"("tenant_id", "permit_id") WHERE "permit_id" IS NOT NULL;
ALTER TABLE "finance_deposits"
  ADD CONSTRAINT "finance_deposits_permit_fkey"
  FOREIGN KEY ("tenant_id", "permit_id", "permit_kind")
  REFERENCES "unit_permits"("tenant_id", "id", "kind")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "finance_deposits_permit_unit_fkey"
  FOREIGN KEY ("tenant_id", "permit_id", "unit_id")
  REFERENCES "unit_permits"("tenant_id", "id", "unit_id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- A named permit is a works permit, and only a finishing-works deposit names one.
ALTER TABLE "finance_deposits" ADD CONSTRAINT "finance_deposits_permit_shape"
  CHECK (("permit_id" IS NULL) = ("permit_kind" IS NULL)
     AND ("permit_id" IS NULL
          OR ("permit_kind" = 'works' AND "kind" = 'finishing_works')));

-- An overturned rejection of a works permit is approved through the checks
-- an approval passes (ADR 0059): a compound that asks for the deposit
-- leaves it to the management while none holds money (`deposit_required`).
-- DECISION_APPEAL_EFFECT_REASONS gains it; the CHECK is recreated whole.
ALTER TABLE "decision_appeals" DROP CONSTRAINT "decision_appeals_state_shape";
ALTER TABLE "decision_appeals" ADD CONSTRAINT "decision_appeals_state_shape"
  CHECK ("status" IN ('pending', 'upheld', 'overturned', 'withdrawn')
     AND ("status" IN ('upheld', 'overturned')) = ("decided_at" IS NOT NULL)
     AND ("decided_at" IS NULL) = ("decided_by_account_id" IS NULL)
     AND ("decided_at" IS NULL) = ("decider_role_key" IS NULL)
     AND ("decider_role_name" IS NULL OR "decided_at" IS NOT NULL)
     AND ("decided_at" IS NULL) = ("rationale" IS NULL)
     AND ("rationale" IS NULL OR char_length("rationale") BETWEEN 1 AND 2000)
     AND ("decided_by_account_id" IS NULL OR "decided_by_account_id" IS DISTINCT FROM "decision_by_account_id")
     AND ("status" = 'withdrawn') = ("withdrawn_at" IS NOT NULL)
     AND ("status" = 'pending') = ("effect" IS NULL)
     AND ("effect" IS NULL OR "effect" IN ('applied', 'follow_up', 'none'))
     AND ("effect" IS DISTINCT FROM 'follow_up' OR "status" = 'overturned')
     AND ("effect_reason" IS NULL OR ("effect" IS NOT NULL AND "effect" IN ('follow_up', 'none')))
     AND ("effect_reason" IS NULL OR "effect_reason" IN (
           'window_passed', 'purged', 'requester_gone', 'unit_limit', 'work_rules', 'blocklisted', 'deposit_required',
           'needs_sticker', 'registrant_gone', 'plate_active', 'permit_date', 'sticker_used', 'changed',
           'needs_review'))
     AND ("followed_up_at" IS NULL OR "effect" IS NOT DISTINCT FROM 'follow_up')
     AND ("followed_up_at" IS NULL) = ("followed_up_by_account_id" IS NULL)
     AND "lodged_at" >= "decision_at"
     AND ("decided_at" IS NULL OR "decided_at" >= "lodged_at")
     AND ("withdrawn_at" IS NULL OR "withdrawn_at" >= "lodged_at"));
