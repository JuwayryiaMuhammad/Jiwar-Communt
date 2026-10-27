-- ============================================================================
-- The technician in the field (ADR 0064).
--
-- field_scans                        a tag scanned on site: an asset's or an
--                                    area's, by whom, when (the database's
--                                    clock). Append-only.
-- asset_replacement_recommendations  a technician's word that an asset
--                                    should be replaced, with a reason code
--                                    and an optional note (the
--                                    technician's, erasable); decided once
--                                    by who keeps the register. One waits
--                                    per asset at most.
-- An asset's history gains both: recommended, and decided.
-- ============================================================================

CREATE TABLE "field_scans" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "asset_id" UUID,
    "common_area_id" UUID,
    "account_id" UUID NOT NULL,
    "scanned_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "field_scans_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "field_scans_asset_idx" ON "field_scans"("tenant_id", "asset_id", "scanned_at" DESC);
CREATE INDEX "field_scans_area_idx" ON "field_scans"("tenant_id", "common_area_id", "scanned_at" DESC);
ALTER TABLE "field_scans" ADD CONSTRAINT "field_scans_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "field_scans" ADD CONSTRAINT "field_scans_asset_fkey"
  FOREIGN KEY ("tenant_id", "asset_id") REFERENCES "assets"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "field_scans" ADD CONSTRAINT "field_scans_common_area_fkey"
  FOREIGN KEY ("tenant_id", "common_area_id") REFERENCES "common_areas"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "field_scans" ADD CONSTRAINT "field_scans_target_one"
  CHECK (("asset_id" IS NULL) <> ("common_area_id" IS NULL));
CREATE TRIGGER "field_scans_immutable_rows" BEFORE UPDATE OR DELETE ON "field_scans"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER "field_scans_immutable_truncate" BEFORE TRUNCATE ON "field_scans"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

CREATE TABLE "asset_replacement_recommendations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "reason_code" TEXT NOT NULL,
    "note" TEXT,
    "recommended_by_account_id" UUID,
    "recommended_at" TIMESTAMPTZ(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "decided_by_account_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "decision_reason" TEXT,
    CONSTRAINT "asset_replacement_recommendations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "asset_replacement_recommendations_tenant_id_id_key"
  ON "asset_replacement_recommendations"("tenant_id", "id");
CREATE UNIQUE INDEX "asset_replacement_recommendations_one_pending"
  ON "asset_replacement_recommendations"("tenant_id", "asset_id") WHERE "status" = 'pending';
CREATE INDEX "asset_replacement_recommendations_queue_idx"
  ON "asset_replacement_recommendations"("tenant_id", "status", "recommended_at" DESC, "id" DESC);
ALTER TABLE "asset_replacement_recommendations" ADD CONSTRAINT "asset_replacement_recommendations_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "asset_replacement_recommendations" ADD CONSTRAINT "asset_replacement_recommendations_asset_fkey"
  FOREIGN KEY ("tenant_id", "asset_id") REFERENCES "assets"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "asset_replacement_recommendations" ADD CONSTRAINT "asset_replacement_recommendations_reason_known"
  CHECK ("reason_code" IN ('end_of_life', 'repeated_failures', 'repair_uneconomic', 'safety', 'obsolete', 'other'));
ALTER TABLE "asset_replacement_recommendations" ADD CONSTRAINT "asset_replacement_recommendations_note_length"
  CHECK ("note" IS NULL OR char_length("note") BETWEEN 1 AND 1000);
-- Pending: undecided. Accepted: no reason needed. Declined: a reason
-- (REASON_CODES.replacementDecline).
ALTER TABLE "asset_replacement_recommendations" ADD CONSTRAINT "asset_replacement_recommendations_state_shape"
  CHECK (("status" = 'pending' AND "decided_at" IS NULL AND "decision_reason" IS NULL)
      OR ("status" = 'accepted' AND "decided_at" IS NOT NULL AND "decision_reason" IS NULL)
      OR ("status" = 'declined' AND "decided_at" IS NOT NULL AND "decision_reason" IS NOT NULL
          AND "decision_reason" IN ('repair_first', 'budget', 'not_needed', 'other')));

-- Decided once; an erasure may clear the note and null who acted.
CREATE FUNCTION "asset_replacement_recommendations_decided_once"() RETURNS trigger AS $$
BEGIN
  IF NEW."asset_id" <> OLD."asset_id" OR NEW."reason_code" <> OLD."reason_code"
     OR NEW."recommended_at" <> OLD."recommended_at" THEN
    RAISE EXCEPTION 'a recommendation keeps its asset and reason' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."status" <> 'pending' AND (
       NEW."status" <> OLD."status" OR NEW."decided_at" IS DISTINCT FROM OLD."decided_at"
       OR NEW."decision_reason" IS DISTINCT FROM OLD."decision_reason") THEN
    RAISE EXCEPTION 'a decided recommendation stays decided' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "asset_replacement_recommendations_decided_once" BEFORE UPDATE ON "asset_replacement_recommendations"
  FOR EACH ROW EXECUTE FUNCTION "asset_replacement_recommendations_decided_once"();
CREATE TRIGGER "asset_replacement_recommendations_no_delete" BEFORE DELETE ON "asset_replacement_recommendations"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();

ALTER TABLE "asset_events" DROP CONSTRAINT "asset_events_kind_known";
ALTER TABLE "asset_events" ADD CONSTRAINT "asset_events_kind_known"
  CHECK ("kind" IN ('created', 'imported', 'updated', 'condition_changed', 'status_changed', 'moved', 'retired', 'tag_issued',
                    'replacement_recommended', 'replacement_decided'));

-- Who acted, in the same compound (composite keys, like every other
-- reference; an erasure nulls a person's columns, it deletes no account).
ALTER TABLE "field_scans" ADD CONSTRAINT "field_scans_account_fkey"
  FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "asset_replacement_recommendations" ADD CONSTRAINT "asset_replacement_recommendations_recommended_by_fkey"
  FOREIGN KEY ("tenant_id", "recommended_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "asset_replacement_recommendations" ADD CONSTRAINT "asset_replacement_recommendations_decided_by_fkey"
  FOREIGN KEY ("tenant_id", "decided_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

REVOKE ALL ON "field_scans", "asset_replacement_recommendations" FROM jiwar_app;
GRANT SELECT, INSERT ON "field_scans" TO jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "asset_replacement_recommendations" TO jiwar_app;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['field_scans', 'asset_replacement_recommendations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
