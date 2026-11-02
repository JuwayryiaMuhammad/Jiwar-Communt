-- ============================================================================
-- Plan suggestions (ADR 0081): repeat faults that ask for planned work.
--
-- When a repair lands (not a plan's own work order, not a check-up) and its
-- category has as many tickets on its asset (else in its unit) within the
-- compound's window as its threshold says, a suggestion is made, once: one
-- open per place and category (the partial unique index; the ticket
-- counter's row lock orders two landings), and none again for a window after
-- one was decided. Whoever keeps the plans (`assets.manage`) accepts it into
-- a plan (a new one, or an active plan of the asset that covers it already)
-- or dismisses it with a reason code. Nothing changes a plan by itself.
--
-- Decided once (a trigger). Counts and times only.
-- ============================================================================

CREATE TABLE "maintenance_plan_suggestions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "asset_id" UUID,
    "unit_id" UUID,
    "category_id" UUID NOT NULL,
    "ticket_count" INTEGER NOT NULL,
    "window_days" INTEGER NOT NULL,
    "first_ticket_at" TIMESTAMPTZ(3) NOT NULL,
    "last_ticket_at" TIMESTAMPTZ(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "decided_at" TIMESTAMPTZ(3),
    "decided_by_account_id" UUID,
    "plan_id" UUID,
    "plan_created" BOOLEAN,
    "reason_code" TEXT,
    CONSTRAINT "maintenance_plan_suggestions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "maintenance_plan_suggestions_tenant_id_id_key"
  ON "maintenance_plan_suggestions"("tenant_id", "id");
CREATE INDEX "maintenance_plan_suggestions_list_idx"
  ON "maintenance_plan_suggestions"("tenant_id", "status", "created_at" DESC, "id" DESC);
CREATE UNIQUE INDEX "maintenance_plan_suggestions_one_open"
  ON "maintenance_plan_suggestions"("tenant_id", "category_id", COALESCE("asset_id", "unit_id"))
  WHERE "status" = 'open';
CREATE INDEX "maintenance_plan_suggestions_place_idx"
  ON "maintenance_plan_suggestions"("tenant_id", "category_id", COALESCE("asset_id", "unit_id"), "decided_at" DESC);
ALTER TABLE "maintenance_plan_suggestions" ADD CONSTRAINT "maintenance_plan_suggestions_tenant_id_asset_id_fkey"
  FOREIGN KEY ("tenant_id", "asset_id") REFERENCES "assets"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "maintenance_plan_suggestions" ADD CONSTRAINT "maintenance_plan_suggestions_tenant_id_unit_id_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "maintenance_plan_suggestions" ADD CONSTRAINT "maintenance_plan_suggestions_tenant_id_category_id_fkey"
  FOREIGN KEY ("tenant_id", "category_id") REFERENCES "ticket_categories"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "maintenance_plan_suggestions" ADD CONSTRAINT "maintenance_plan_suggestions_tenant_id_decided_by_fkey"
  FOREIGN KEY ("tenant_id", "decided_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "maintenance_plan_suggestions" ADD CONSTRAINT "maintenance_plan_suggestions_tenant_id_plan_id_fkey"
  FOREIGN KEY ("tenant_id", "plan_id") REFERENCES "maintenance_plans"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- One place: an asset or a unit, never both.
ALTER TABLE "maintenance_plan_suggestions" ADD CONSTRAINT "maintenance_plan_suggestions_place"
  CHECK (("asset_id" IS NULL) <> ("unit_id" IS NULL));
ALTER TABLE "maintenance_plan_suggestions" ADD CONSTRAINT "maintenance_plan_suggestions_counts"
  CHECK ("status" IN ('open', 'accepted', 'dismissed')
     AND "ticket_count" >= 2 AND "window_days" BETWEEN 1 AND 366
     AND "first_ticket_at" <= "last_ticket_at");
-- Open: nobody decided it. Accepted: into a plan (made for it or not).
-- Dismissed: with a reason code.
ALTER TABLE "maintenance_plan_suggestions" ADD CONSTRAINT "maintenance_plan_suggestions_decided_shape"
  CHECK ((("status" = 'open') = ("decided_at" IS NULL))
     AND (("decided_at" IS NULL) = ("decided_by_account_id" IS NULL))
     AND (("status" = 'accepted') = ("plan_id" IS NOT NULL))
     AND (("plan_id" IS NULL) = ("plan_created" IS NULL))
     AND (("status" = 'dismissed') = ("reason_code" IS NOT NULL)));

CREATE FUNCTION "maintenance_plan_suggestions_decided_once"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" <> 'open'
     OR NEW."asset_id" IS DISTINCT FROM OLD."asset_id"
     OR NEW."unit_id" IS DISTINCT FROM OLD."unit_id"
     OR NEW."category_id" <> OLD."category_id"
     OR NEW."ticket_count" <> OLD."ticket_count"
     OR NEW."window_days" <> OLD."window_days"
     OR NEW."first_ticket_at" <> OLD."first_ticket_at"
     OR NEW."last_ticket_at" <> OLD."last_ticket_at"
     OR NEW."created_at" <> OLD."created_at" THEN
    RAISE EXCEPTION 'a plan suggestion is decided once' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "maintenance_plan_suggestions_decided_once" BEFORE UPDATE ON "maintenance_plan_suggestions"
  FOR EACH ROW EXECUTE FUNCTION "maintenance_plan_suggestions_decided_once"();

REVOKE ALL ON "maintenance_plan_suggestions" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "maintenance_plan_suggestions" TO jiwar_app;
ALTER TABLE "maintenance_plan_suggestions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "maintenance_plan_suggestions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "maintenance_plan_suggestions"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
