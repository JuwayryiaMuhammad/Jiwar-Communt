-- ============================================================================
-- Field inspections (ADR 0064).
--
-- inspection_rounds    a recurring inspection: a checklist, a target (an
--                      asset not in a unit, or a common area), an
--                      inspector, a fixed series on the compound's
--                      calendar. Its sweep opens one inspection per due
--                      date, `lead_days` before (once per round and date).
-- inspections          one inspection, from a round or on its own: due on a
--                      day; scheduled, in progress (started, the target's
--                      tag scanned when its checklist asks), submitted with
--                      its run's attestation, or cancelled with a reason.
-- inspection_findings  a failed item that asked for one: its follow-up
--                      work order (origin `inspection`), once per item.
-- A checklist run is now a ticket cycle's or an inspection's, never both.
-- ============================================================================

CREATE TABLE "inspection_rounds" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "checklist_id" UUID NOT NULL,
    "asset_id" UUID,
    "common_area_id" UUID,
    "assignee_account_id" UUID NOT NULL,
    "every" SMALLINT NOT NULL,
    "unit" TEXT NOT NULL,
    "anchor_on" DATE NOT NULL,
    "next_due_on" DATE NOT NULL,
    "lead_days" SMALLINT NOT NULL DEFAULT 2,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "inspection_rounds_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "inspection_rounds_tenant_id_id_key" ON "inspection_rounds"("tenant_id", "id");
CREATE INDEX "inspection_rounds_list_idx" ON "inspection_rounds"("tenant_id", "created_at" DESC, "id" DESC);
CREATE INDEX "inspection_rounds_due_idx" ON "inspection_rounds"("tenant_id", "next_due_on") WHERE "active";
ALTER TABLE "inspection_rounds" ADD CONSTRAINT "inspection_rounds_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "inspection_rounds" ADD CONSTRAINT "inspection_rounds_checklist_fkey"
  FOREIGN KEY ("tenant_id", "checklist_id") REFERENCES "checklist_templates"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "inspection_rounds" ADD CONSTRAINT "inspection_rounds_asset_fkey"
  FOREIGN KEY ("tenant_id", "asset_id") REFERENCES "assets"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "inspection_rounds" ADD CONSTRAINT "inspection_rounds_common_area_fkey"
  FOREIGN KEY ("tenant_id", "common_area_id") REFERENCES "common_areas"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "inspection_rounds" ADD CONSTRAINT "inspection_rounds_assignee_fkey"
  FOREIGN KEY ("tenant_id", "assignee_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "inspection_rounds" ADD CONSTRAINT "inspection_rounds_target_one"
  CHECK (("asset_id" IS NULL) <> ("common_area_id" IS NULL));
ALTER TABLE "inspection_rounds" ADD CONSTRAINT "inspection_rounds_title_length"
  CHECK (char_length("title") BETWEEN 1 AND 120);
ALTER TABLE "inspection_rounds" ADD CONSTRAINT "inspection_rounds_series_shape"
  CHECK ("every" BETWEEN 1 AND 365 AND "unit" IN ('day', 'week', 'month', 'year')
     AND "lead_days" BETWEEN 0 AND 60);

CREATE TABLE "inspections" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "round_id" UUID,
    "checklist_id" UUID NOT NULL,
    "asset_id" UUID,
    "common_area_id" UUID,
    "assignee_account_id" UUID NOT NULL,
    "original_due_on" DATE NOT NULL,
    "due_on" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "started_at" TIMESTAMPTZ(3),
    "scanned_at" TIMESTAMPTZ(3),
    "submitted_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" TEXT,
    "overdue_alerted_at" TIMESTAMPTZ(3),
    CONSTRAINT "inspections_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "inspections_tenant_id_id_key" ON "inspections"("tenant_id", "id");
CREATE UNIQUE INDEX "inspections_round_once" ON "inspections"("round_id", "original_due_on")
  WHERE "round_id" IS NOT NULL;
CREATE INDEX "inspections_list_idx" ON "inspections"("tenant_id", "due_on" DESC, "id" DESC);
CREATE INDEX "inspections_assignee_idx" ON "inspections"("tenant_id", "assignee_account_id", "status", "due_on");
CREATE INDEX "inspections_open_idx" ON "inspections"("tenant_id", "due_on")
  WHERE "status" IN ('scheduled', 'in_progress');
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_round_fkey"
  FOREIGN KEY ("tenant_id", "round_id") REFERENCES "inspection_rounds"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_checklist_fkey"
  FOREIGN KEY ("tenant_id", "checklist_id") REFERENCES "checklist_templates"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_asset_fkey"
  FOREIGN KEY ("tenant_id", "asset_id") REFERENCES "assets"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_common_area_fkey"
  FOREIGN KEY ("tenant_id", "common_area_id") REFERENCES "common_areas"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_assignee_fkey"
  FOREIGN KEY ("tenant_id", "assignee_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_target_one"
  CHECK (("asset_id" IS NULL) <> ("common_area_id" IS NULL));
-- Scheduled: nothing yet. In progress: started (and maybe scanned).
-- Submitted: started and submitted. Cancelled: with a reason
-- (REASON_CODES.inspectionCancel), at any point before submitted.
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_state_shape"
  CHECK (("status" = 'scheduled' AND "started_at" IS NULL AND "submitted_at" IS NULL
          AND "cancelled_at" IS NULL AND "cancel_reason" IS NULL)
      OR ("status" = 'in_progress' AND "started_at" IS NOT NULL AND "submitted_at" IS NULL
          AND "cancelled_at" IS NULL AND "cancel_reason" IS NULL)
      OR ("status" = 'submitted' AND "started_at" IS NOT NULL AND "submitted_at" IS NOT NULL
          AND "cancelled_at" IS NULL AND "cancel_reason" IS NULL)
      OR ("status" = 'cancelled' AND "submitted_at" IS NULL AND "cancelled_at" IS NOT NULL
          AND "cancel_reason" IS NOT NULL
          AND "cancel_reason" IN ('not_needed', 'duplicate', 'target_unavailable', 'other')));
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_scan_after_start"
  CHECK ("scanned_at" IS NULL OR "started_at" IS NOT NULL);

-- An ended inspection never changes; none keeps another target.
CREATE FUNCTION "inspections_ended_once"() RETURNS trigger AS $$
BEGIN
  IF NEW."round_id" IS DISTINCT FROM OLD."round_id" OR NEW."checklist_id" <> OLD."checklist_id"
     OR NEW."asset_id" IS DISTINCT FROM OLD."asset_id"
     OR NEW."common_area_id" IS DISTINCT FROM OLD."common_area_id"
     OR NEW."original_due_on" <> OLD."original_due_on" THEN
    RAISE EXCEPTION 'an inspection keeps its round, checklist and target' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."status" IN ('submitted', 'cancelled') THEN
    RAISE EXCEPTION 'an ended inspection never changes' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "inspections_ended_once" BEFORE UPDATE ON "inspections"
  FOR EACH ROW EXECUTE FUNCTION "inspections_ended_once"();
CREATE TRIGGER "inspections_no_delete" BEFORE DELETE ON "inspections"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER "inspections_immutable_truncate" BEFORE TRUNCATE ON "inspections"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- A run is a ticket cycle's or an inspection's.
ALTER TABLE "checklist_runs" ADD COLUMN "inspection_id" UUID;
ALTER TABLE "checklist_runs" ADD CONSTRAINT "checklist_runs_inspection_fkey"
  FOREIGN KEY ("tenant_id", "inspection_id") REFERENCES "inspections"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE UNIQUE INDEX "checklist_runs_inspection_key" ON "checklist_runs"("inspection_id")
  WHERE "inspection_id" IS NOT NULL;
ALTER TABLE "checklist_runs" ADD CONSTRAINT "checklist_runs_subject_one"
  CHECK (num_nonnulls("ticket_id", "inspection_id") = 1);

CREATE OR REPLACE FUNCTION "checklist_runs_submitted_once"() RETURNS trigger AS $$
BEGIN
  IF NEW."template_id" <> OLD."template_id" OR NEW."version" <> OLD."version"
     OR NEW."ticket_id" IS DISTINCT FROM OLD."ticket_id"
     OR NEW."inspection_id" IS DISTINCT FROM OLD."inspection_id"
     OR NEW."cycle" IS DISTINCT FROM OLD."cycle"
     OR NEW."asset_id" IS DISTINCT FROM OLD."asset_id" THEN
    RAISE EXCEPTION 'a run keeps what it is of' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."status" = 'submitted' AND (
       NEW."status" <> 'submitted'
       OR NEW."submitted_at" IS DISTINCT FROM OLD."submitted_at"
       OR NEW."attestation_sha256" IS DISTINCT FROM OLD."attestation_sha256"
       OR (NEW."submitted_by_account_id" IS NOT NULL
           AND NEW."submitted_by_account_id" IS DISTINCT FROM OLD."submitted_by_account_id")) THEN
    RAISE EXCEPTION 'a submitted run never changes' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TABLE "inspection_findings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "inspection_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "inspection_findings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "inspection_findings_tenant_id_id_key" ON "inspection_findings"("tenant_id", "id");
CREATE UNIQUE INDEX "inspection_findings_once" ON "inspection_findings"("inspection_id", "item_id");
CREATE UNIQUE INDEX "inspection_findings_ticket_key" ON "inspection_findings"("ticket_id");
ALTER TABLE "inspection_findings" ADD CONSTRAINT "inspection_findings_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "inspection_findings" ADD CONSTRAINT "inspection_findings_inspection_fkey"
  FOREIGN KEY ("tenant_id", "inspection_id") REFERENCES "inspections"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "inspection_findings" ADD CONSTRAINT "inspection_findings_item_fkey"
  FOREIGN KEY ("tenant_id", "item_id") REFERENCES "checklist_template_items"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "inspection_findings" ADD CONSTRAINT "inspection_findings_ticket_fkey"
  FOREIGN KEY ("tenant_id", "ticket_id") REFERENCES "tickets"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE TRIGGER "inspection_findings_immutable_rows" BEFORE UPDATE OR DELETE ON "inspection_findings"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER "inspection_findings_immutable_truncate" BEFORE TRUNCATE ON "inspection_findings"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "inspection_rounds", "inspections", "inspection_findings" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "inspection_rounds", "inspections" TO jiwar_app;
GRANT SELECT, INSERT ON "inspection_findings" TO jiwar_app;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['inspection_rounds', 'inspections', 'inspection_findings'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
