-- ============================================================================
-- Readiness campaigns (ADR 0067): the inspections a campaign item spawned,
-- one per target (an asset or a common area) and item, each an inspection
-- of its own. Spawning again adds only the targets it does not hold yet.
-- The item is done when every one of them is submitted or cancelled. Never
-- changed, never deleted.
-- ============================================================================

CREATE TABLE "readiness_campaign_inspections" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "inspection_id" UUID NOT NULL,
    "asset_id" UUID,
    "common_area_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "readiness_campaign_inspections_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "readiness_campaign_inspections_tenant_id_id_key"
  ON "readiness_campaign_inspections"("tenant_id", "id");
-- An inspection belongs to one campaign; a target is inspected once per campaign.
CREATE UNIQUE INDEX "readiness_campaign_inspections_inspection_key"
  ON "readiness_campaign_inspections"("tenant_id", "inspection_id");
CREATE UNIQUE INDEX "readiness_campaign_inspections_asset_key"
  ON "readiness_campaign_inspections"("tenant_id", "item_id", "asset_id")
  WHERE "asset_id" IS NOT NULL;
CREATE UNIQUE INDEX "readiness_campaign_inspections_area_key"
  ON "readiness_campaign_inspections"("tenant_id", "item_id", "common_area_id")
  WHERE "common_area_id" IS NOT NULL;
ALTER TABLE "readiness_campaign_inspections" ADD CONSTRAINT "readiness_campaign_inspections_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "readiness_campaign_inspections" ADD CONSTRAINT "readiness_campaign_inspections_item_fkey"
  FOREIGN KEY ("tenant_id", "item_id") REFERENCES "readiness_items"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "readiness_campaign_inspections" ADD CONSTRAINT "readiness_campaign_inspections_inspection_fkey"
  FOREIGN KEY ("tenant_id", "inspection_id") REFERENCES "inspections"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "readiness_campaign_inspections" ADD CONSTRAINT "readiness_campaign_inspections_asset_fkey"
  FOREIGN KEY ("tenant_id", "asset_id") REFERENCES "assets"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "readiness_campaign_inspections" ADD CONSTRAINT "readiness_campaign_inspections_area_fkey"
  FOREIGN KEY ("tenant_id", "common_area_id") REFERENCES "common_areas"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- An asset or a common area, never both, never neither: as the inspection's.
ALTER TABLE "readiness_campaign_inspections" ADD CONSTRAINT "readiness_campaign_inspections_target_one"
  CHECK (("asset_id" IS NULL) <> ("common_area_id" IS NULL));

CREATE TRIGGER "readiness_campaign_inspections_immutable"
  BEFORE UPDATE OR DELETE ON "readiness_campaign_inspections"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER "readiness_campaign_inspections_immutable_truncate"
  BEFORE TRUNCATE ON "readiness_campaign_inspections"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Grants: added, then only read. RLS, FORCE.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "readiness_campaign_inspections" FROM jiwar_app;
GRANT SELECT, INSERT ON "readiness_campaign_inspections" TO jiwar_app;

ALTER TABLE "readiness_campaign_inspections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "readiness_campaign_inspections" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "readiness_campaign_inspections"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
