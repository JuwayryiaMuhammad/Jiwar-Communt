-- ============================================================================
-- R11c-1a (ADR 0069): what a fee is and why it changed.
--
-- A billing plan says to the residents it bills what it pays for, in both
-- languages. Its amount used to change in place with nothing kept: now each
-- change is a row — from, to, the first period billed at it and, when the
-- board decided it, the published decision — so a resident's invoice can
-- say why it differs from the one before. A row is a fact: never edited,
-- never deleted.
-- ============================================================================

ALTER TABLE "billing_plans"
  ADD COLUMN "description_en" TEXT,
  ADD COLUMN "description_ar" TEXT;
ALTER TABLE "billing_plans" ADD CONSTRAINT "billing_plans_description"
  CHECK (("description_en" IS NULL) = ("description_ar" IS NULL)
     AND ("description_en" IS NULL OR char_length("description_en") BETWEEN 1 AND 1000)
     AND ("description_ar" IS NULL OR char_length("description_ar") BETWEEN 1 AND 1000));

CREATE TABLE "billing_plan_amount_changes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "from_amount" DECIMAL(12,2) NOT NULL,
    "to_amount" DECIMAL(12,2) NOT NULL,
    "effective_on" DATE NOT NULL,
    "decision_publication_id" UUID,
    "changed_by" UUID NOT NULL,
    "changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    CONSTRAINT "billing_plan_amount_changes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "billing_plan_amount_changes_tenant_id_id_key"
  ON "billing_plan_amount_changes"("tenant_id", "id");
CREATE INDEX "billing_plan_amount_changes_plan_idx"
  ON "billing_plan_amount_changes"("tenant_id", "plan_id", "changed_at");
ALTER TABLE "billing_plan_amount_changes"
  ADD CONSTRAINT "billing_plan_amount_changes_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "billing_plan_amount_changes_plan_fkey"
  FOREIGN KEY ("tenant_id", "plan_id") REFERENCES "billing_plans"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "billing_plan_amount_changes_decision_fkey"
  FOREIGN KEY ("tenant_id", "decision_publication_id") REFERENCES "board_publications"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "billing_plan_amount_changes_changed_by_fkey"
  FOREIGN KEY ("tenant_id", "changed_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- A change changes something, to an amount a plan may bill.
ALTER TABLE "billing_plan_amount_changes" ADD CONSTRAINT "billing_plan_amount_changes_amounts"
  CHECK ("from_amount" > 0 AND "to_amount" > 0 AND "from_amount" <> "to_amount");

CREATE TRIGGER billing_plan_amount_changes_immutable
  BEFORE UPDATE OR DELETE ON "billing_plan_amount_changes"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER billing_plan_amount_changes_no_truncate
  BEFORE TRUNCATE ON "billing_plan_amount_changes"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "billing_plan_amount_changes" FROM jiwar_app;
GRANT SELECT, INSERT ON "billing_plan_amount_changes" TO jiwar_app;
ALTER TABLE "billing_plan_amount_changes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing_plan_amount_changes" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "billing_plan_amount_changes"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
