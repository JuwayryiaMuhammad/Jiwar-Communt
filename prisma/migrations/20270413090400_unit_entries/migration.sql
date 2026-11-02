-- ============================================================================
-- Emergency entries into a unit (ADR 0083)
-- ============================================================================
--
-- Staff went into a unit without its owner, for a danger. The entry is
-- recorded by whoever led it (`guard_tasks.manage`): the unit, the reason's
-- code (REASON_CODES.unitEntryReason), when, one to three staff witnesses
-- and photos before; then reported once: what was found
-- (REASON_CODES.unitEntryOutcome), the staff's words and photos after. The
-- unit's occupants and its proxies for inspections are told at each step.
--
-- The report's words describe the unit, not a person: kept when its writer
-- is erased (as a found item's description, ADR 0050). Never deleted.
-- ============================================================================

CREATE TABLE "unit_entries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "unit_id" UUID NOT NULL,
    "reason_code" TEXT NOT NULL,
    "entered_at" TIMESTAMPTZ(3) NOT NULL,
    "recorded_by" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "outcome" TEXT,
    "report_note" TEXT,
    "reported_by" UUID,
    "reported_at" TIMESTAMPTZ(3),
    CONSTRAINT "unit_entries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "unit_entries_tenant_id_id_key" ON "unit_entries"("tenant_id", "id");
CREATE UNIQUE INDEX "unit_entries_number_key" ON "unit_entries"("tenant_id", "number");
CREATE INDEX "unit_entries_list_idx"
  ON "unit_entries"("tenant_id", "recorded_at" DESC, "id" DESC);
CREATE INDEX "unit_entries_unit_idx"
  ON "unit_entries"("tenant_id", "unit_id", "recorded_at" DESC);
CREATE INDEX "unit_entries_open_idx"
  ON "unit_entries"("tenant_id", "recorded_at", "id") WHERE "status" = 'open';
ALTER TABLE "unit_entries"
  ADD CONSTRAINT "unit_entries_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_entries_unit_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_entries_recorded_by_fkey"
  FOREIGN KEY ("tenant_id", "recorded_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_entries_reported_by_fkey"
  FOREIGN KEY ("tenant_id", "reported_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "unit_entries" ADD CONSTRAINT "unit_entries_reason_known"
  CHECK ("reason_code" IN ('water_leak', 'fire', 'smoke', 'gas_smell', 'electrical_hazard',
    'structural_danger', 'security_threat', 'other')
     AND "entered_at" <= "recorded_at" + interval '5 minutes');
-- Open: no report. Reported: what was found, the words, who and when.
ALTER TABLE "unit_entries" ADD CONSTRAINT "unit_entries_report_shape"
  CHECK ("status" IN ('open', 'reported')
     AND (("status" = 'reported') = ("reported_at" IS NOT NULL))
     AND (("reported_at" IS NULL) = ("reported_by" IS NULL))
     AND (("reported_at" IS NULL) = ("outcome" IS NULL))
     AND (("reported_at" IS NULL) = ("report_note" IS NULL))
     AND ("outcome" IS NULL OR "outcome" IN ('resolved', 'contained', 'no_issue_found',
           'needs_maintenance', 'other'))
     AND ("report_note" IS NULL OR char_length("report_note") BETWEEN 1 AND 2000)
     AND ("reported_at" IS NULL OR "reported_at" >= "recorded_at"));

-- Reported once: an open entry changes only into its report; a reported one
-- never changes. Never deleted.
CREATE FUNCTION "unit_entries_reported_once"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."status" = 'open' AND NEW."status" = 'reported'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."number" = OLD."number" AND NEW."unit_id" = OLD."unit_id"
     AND NEW."reason_code" = OLD."reason_code"
     AND NEW."entered_at" = OLD."entered_at"
     AND NEW."recorded_by" = OLD."recorded_by"
     AND NEW."recorded_at" = OLD."recorded_at" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'unit_entries: an entry is reported once, and never deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER "unit_entries_reported_once"
  BEFORE UPDATE OR DELETE ON "unit_entries"
  FOR EACH ROW EXECUTE FUNCTION "unit_entries_reported_once"();
CREATE TRIGGER "unit_entries_no_truncate"
  BEFORE TRUNCATE ON "unit_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- The entry's witnesses: staff accounts, written with it, never changed.
CREATE TABLE "unit_entry_witnesses" (
    "tenant_id" UUID NOT NULL,
    "entry_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    CONSTRAINT "unit_entry_witnesses_pkey" PRIMARY KEY ("tenant_id", "entry_id", "account_id")
);
CREATE INDEX "unit_entry_witnesses_account_idx"
  ON "unit_entry_witnesses"("tenant_id", "account_id");
ALTER TABLE "unit_entry_witnesses"
  ADD CONSTRAINT "unit_entry_witnesses_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_entry_witnesses_entry_fkey"
  FOREIGN KEY ("tenant_id", "entry_id") REFERENCES "unit_entries"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_entry_witnesses_account_fkey"
  FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Its photos, before (with the record) and after (with the report).
CREATE TABLE "unit_entry_photos" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "entry_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "stage" TEXT NOT NULL,
    "uploaded_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "unit_entry_photos_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "unit_entry_photos_tenant_id_id_key" ON "unit_entry_photos"("tenant_id", "id");
CREATE UNIQUE INDEX "unit_entry_photos_file_id_key" ON "unit_entry_photos"("file_id");
CREATE INDEX "unit_entry_photos_entry_idx" ON "unit_entry_photos"("tenant_id", "entry_id");
ALTER TABLE "unit_entry_photos"
  ADD CONSTRAINT "unit_entry_photos_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_entry_photos_entry_fkey"
  FOREIGN KEY ("tenant_id", "entry_id") REFERENCES "unit_entries"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_entry_photos_file_fkey"
  FOREIGN KEY ("tenant_id", "file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_entry_photos_uploaded_by_fkey"
  FOREIGN KEY ("tenant_id", "uploaded_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "unit_entry_photos" ADD CONSTRAINT "unit_entry_photos_stage"
  CHECK ("stage" IN ('before', 'after'));

CREATE FUNCTION "unit_entry_rows_immutable"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%: an entry''s witnesses and photos never change (%)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER "unit_entry_witnesses_immutable"
  BEFORE UPDATE OR DELETE ON "unit_entry_witnesses"
  FOR EACH ROW EXECUTE FUNCTION "unit_entry_rows_immutable"();
CREATE TRIGGER "unit_entry_photos_immutable"
  BEFORE UPDATE OR DELETE ON "unit_entry_photos"
  FOR EACH ROW EXECUTE FUNCTION "unit_entry_rows_immutable"();

REVOKE ALL ON "unit_entries", "unit_entry_witnesses", "unit_entry_photos" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "unit_entries" TO jiwar_app;
GRANT SELECT, INSERT ON "unit_entry_witnesses", "unit_entry_photos" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['unit_entries', 'unit_entry_witnesses', 'unit_entry_photos'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
