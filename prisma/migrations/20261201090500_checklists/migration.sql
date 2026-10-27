-- ============================================================================
-- Checklists (ADR 0064): what a planned job or an inspection goes through,
-- item by item.
--
-- checklist_templates       the compound's checklists, by purpose; each
--                           edit of its items is a new version, so a run
--                           keeps the items it was given.
-- checklist_template_items  one version's items: a check (pass, fail, n/a),
--                           a reading (a number, its metric, the range it
--                           should be in), a photo, a note. Never changed.
-- checklist_runs            one checklist being filled: of a ticket's cycle
--                           (an inspection's later), of the version it
--                           took; open, then submitted once with the
--                           SHA-256 of its answers (the inspector's
--                           signature: who, when, exactly what).
-- checklist_answers         one per item and run, redone until the run is
--                           submitted; then frozen, with their photos.
-- asset_readings            what an asset measured: from a run or entered
--                           by hand. Never changed.
-- ============================================================================

CREATE TABLE "checklist_templates" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name_ar" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "require_scan" BOOLEAN NOT NULL DEFAULT false,
    "current_version" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "checklist_templates_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "checklist_templates_tenant_id_id_key" ON "checklist_templates"("tenant_id", "id");
CREATE UNIQUE INDEX "checklist_templates_tenant_id_key_key" ON "checklist_templates"("tenant_id", "key");
ALTER TABLE "checklist_templates" ADD CONSTRAINT "checklist_templates_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "checklist_templates" ADD CONSTRAINT "checklist_templates_key_shape"
  CHECK ("key" ~ '^[a-z][a-z0-9_]{1,39}$');
ALTER TABLE "checklist_templates" ADD CONSTRAINT "checklist_templates_names_length"
  CHECK (char_length("name_ar") BETWEEN 1 AND 80 AND char_length("name_en") BETWEEN 1 AND 80);
ALTER TABLE "checklist_templates" ADD CONSTRAINT "checklist_templates_purpose_known"
  CHECK ("purpose" IN ('pm', 'inspection', 'any'));
ALTER TABLE "checklist_templates" ADD CONSTRAINT "checklist_templates_version_range"
  CHECK ("current_version" BETWEEN 1 AND 10000);

CREATE TABLE "checklist_template_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "position" SMALLINT NOT NULL,
    "kind" TEXT NOT NULL,
    "label_ar" TEXT NOT NULL,
    "label_en" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "metric_key" TEXT,
    "unit" TEXT,
    "min_value" DECIMAL(14,4),
    "max_value" DECIMAL(14,4),
    "fail_creates_ticket" BOOLEAN NOT NULL DEFAULT false,
    "follow_up_category_id" UUID,
    "follow_up_priority" "ticket_priority",
    CONSTRAINT "checklist_template_items_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "checklist_template_items_tenant_id_id_key" ON "checklist_template_items"("tenant_id", "id");
CREATE UNIQUE INDEX "checklist_template_items_position_key"
  ON "checklist_template_items"("template_id", "version", "position");
ALTER TABLE "checklist_template_items" ADD CONSTRAINT "checklist_template_items_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "checklist_template_items" ADD CONSTRAINT "checklist_template_items_template_fkey"
  FOREIGN KEY ("tenant_id", "template_id") REFERENCES "checklist_templates"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "checklist_template_items" ADD CONSTRAINT "checklist_template_items_category_fkey"
  FOREIGN KEY ("tenant_id", "follow_up_category_id") REFERENCES "ticket_categories"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "checklist_template_items" ADD CONSTRAINT "checklist_template_items_version_range"
  CHECK ("version" BETWEEN 1 AND 10000 AND "position" BETWEEN 1 AND 100);
ALTER TABLE "checklist_template_items" ADD CONSTRAINT "checklist_template_items_kind_known"
  CHECK ("kind" IN ('check', 'reading', 'photo', 'text'));
ALTER TABLE "checklist_template_items" ADD CONSTRAINT "checklist_template_items_labels_length"
  CHECK (char_length("label_ar") BETWEEN 1 AND 200 AND char_length("label_en") BETWEEN 1 AND 200);
-- A reading names its metric (and may give a unit and a range, low ≤
-- high); nothing else does. Only a check or a reading fails, and only a
-- failing one opens a follow-up, with its category and priority.
ALTER TABLE "checklist_template_items" ADD CONSTRAINT "checklist_template_items_reading_shape"
  CHECK (("kind" = 'reading' AND "metric_key" IS NOT NULL AND "metric_key" ~ '^[a-z][a-z0-9_]{1,39}$'
          AND ("unit" IS NULL OR char_length("unit") BETWEEN 1 AND 16)
          AND ("min_value" IS NULL OR "max_value" IS NULL OR "min_value" <= "max_value"))
      OR ("kind" <> 'reading' AND "metric_key" IS NULL AND "unit" IS NULL
          AND "min_value" IS NULL AND "max_value" IS NULL));
ALTER TABLE "checklist_template_items" ADD CONSTRAINT "checklist_template_items_follow_up_shape"
  CHECK (("fail_creates_ticket" AND "kind" IN ('check', 'reading')
          AND "follow_up_category_id" IS NOT NULL AND "follow_up_priority" IS NOT NULL)
      OR (NOT "fail_creates_ticket" AND "follow_up_category_id" IS NULL AND "follow_up_priority" IS NULL));
CREATE TRIGGER "checklist_template_items_immutable_rows" BEFORE UPDATE OR DELETE ON "checklist_template_items"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER "checklist_template_items_immutable_truncate" BEFORE TRUNCATE ON "checklist_template_items"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

CREATE TABLE "checklist_runs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "ticket_id" UUID,
    "cycle" INTEGER,
    "asset_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "submitted_at" TIMESTAMPTZ(3),
    "submitted_by_account_id" UUID,
    "attestation_sha256" TEXT,
    CONSTRAINT "checklist_runs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "checklist_runs_tenant_id_id_key" ON "checklist_runs"("tenant_id", "id");
CREATE UNIQUE INDEX "checklist_runs_ticket_cycle_key" ON "checklist_runs"("ticket_id", "cycle")
  WHERE "ticket_id" IS NOT NULL;
CREATE INDEX "checklist_runs_asset_idx" ON "checklist_runs"("tenant_id", "asset_id", "submitted_at");
ALTER TABLE "checklist_runs" ADD CONSTRAINT "checklist_runs_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "checklist_runs" ADD CONSTRAINT "checklist_runs_template_fkey"
  FOREIGN KEY ("tenant_id", "template_id") REFERENCES "checklist_templates"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "checklist_runs" ADD CONSTRAINT "checklist_runs_ticket_fkey"
  FOREIGN KEY ("tenant_id", "ticket_id") REFERENCES "tickets"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "checklist_runs" ADD CONSTRAINT "checklist_runs_asset_fkey"
  FOREIGN KEY ("tenant_id", "asset_id") REFERENCES "assets"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "checklist_runs" ADD CONSTRAINT "checklist_runs_ticket_shape"
  CHECK (("ticket_id" IS NULL) = ("cycle" IS NULL));
ALTER TABLE "checklist_runs" ADD CONSTRAINT "checklist_runs_status_shape"
  CHECK (("status" = 'open' AND "submitted_at" IS NULL AND "attestation_sha256" IS NULL)
      OR ("status" = 'submitted' AND "submitted_at" IS NOT NULL AND "attestation_sha256" IS NOT NULL
          AND "attestation_sha256" ~ '^[0-9a-f]{64}$'));

-- A submitted run stays as it was submitted (its submitter alone may be
-- nulled by an erasure).
CREATE FUNCTION "checklist_runs_submitted_once"() RETURNS trigger AS $$
BEGIN
  IF NEW."template_id" <> OLD."template_id" OR NEW."version" <> OLD."version"
     OR NEW."ticket_id" IS DISTINCT FROM OLD."ticket_id"
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
CREATE TRIGGER "checklist_runs_submitted_once" BEFORE UPDATE ON "checklist_runs"
  FOR EACH ROW EXECUTE FUNCTION "checklist_runs_submitted_once"();
CREATE TRIGGER "checklist_runs_no_delete" BEFORE DELETE ON "checklist_runs"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER "checklist_runs_immutable_truncate" BEFORE TRUNCATE ON "checklist_runs"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

CREATE TABLE "checklist_answers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "result" TEXT,
    "value" DECIMAL(14,4),
    "note" TEXT,
    "answered_by_account_id" UUID,
    "answered_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "checklist_answers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "checklist_answers_tenant_id_id_key" ON "checklist_answers"("tenant_id", "id");
CREATE UNIQUE INDEX "checklist_answers_run_item_key" ON "checklist_answers"("run_id", "item_id");
ALTER TABLE "checklist_answers" ADD CONSTRAINT "checklist_answers_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "checklist_answers" ADD CONSTRAINT "checklist_answers_run_fkey"
  FOREIGN KEY ("tenant_id", "run_id") REFERENCES "checklist_runs"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "checklist_answers" ADD CONSTRAINT "checklist_answers_item_fkey"
  FOREIGN KEY ("tenant_id", "item_id") REFERENCES "checklist_template_items"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "checklist_answers" ADD CONSTRAINT "checklist_answers_result_known"
  CHECK ("result" IS NULL OR "result" IN ('pass', 'fail', 'na'));
ALTER TABLE "checklist_answers" ADD CONSTRAINT "checklist_answers_note_length"
  CHECK ("note" IS NULL OR char_length("note") BETWEEN 1 AND 1000);

-- Answers change only while their run is open (FOR UPDATE on the run by
-- the writer; this is the database's word on it).
CREATE FUNCTION "checklist_answers_while_open"() RETURNS trigger AS $$
DECLARE
  run_status text;
BEGIN
  SELECT "status" INTO run_status FROM "checklist_runs"
   WHERE "id" = COALESCE(NEW."run_id", OLD."run_id");
  IF run_status = 'submitted' THEN
    -- An erasure may still null who answered.
    IF TG_OP = 'UPDATE' AND NEW."result" IS NOT DISTINCT FROM OLD."result"
       AND NEW."value" IS NOT DISTINCT FROM OLD."value"
       AND NEW."note" IS NOT DISTINCT FROM OLD."note"
       AND NEW."answered_at" = OLD."answered_at"
       AND NEW."answered_by_account_id" IS NULL THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'the run is submitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "checklist_answers_while_open" BEFORE INSERT OR UPDATE OR DELETE ON "checklist_answers"
  FOR EACH ROW EXECUTE FUNCTION "checklist_answers_while_open"();

CREATE TABLE "checklist_answer_photos" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "answer_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "checklist_answer_photos_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "checklist_answer_photos_file_id_key" ON "checklist_answer_photos"("file_id");
CREATE INDEX "checklist_answer_photos_answer_idx" ON "checklist_answer_photos"("tenant_id", "answer_id", "created_at");
ALTER TABLE "checklist_answer_photos" ADD CONSTRAINT "checklist_answer_photos_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "checklist_answer_photos" ADD CONSTRAINT "checklist_answer_photos_answer_fkey"
  FOREIGN KEY ("tenant_id", "answer_id") REFERENCES "checklist_answers"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "checklist_answer_photos" ADD CONSTRAINT "checklist_answer_photos_file_fkey"
  FOREIGN KEY ("tenant_id", "file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE TRIGGER "checklist_answer_photos_immutable_rows" BEFORE UPDATE OR DELETE ON "checklist_answer_photos"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER "checklist_answer_photos_immutable_truncate" BEFORE TRUNCATE ON "checklist_answer_photos"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

CREATE TABLE "asset_readings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "metric_key" TEXT NOT NULL,
    "value" DECIMAL(14,4) NOT NULL,
    "unit" TEXT,
    "source" TEXT NOT NULL,
    "run_id" UUID,
    "recorded_by_account_id" UUID,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "asset_readings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "asset_readings_tenant_id_id_key" ON "asset_readings"("tenant_id", "id");
CREATE INDEX "asset_readings_metric_idx"
  ON "asset_readings"("tenant_id", "asset_id", "metric_key", "occurred_at" DESC, "id" DESC);
ALTER TABLE "asset_readings" ADD CONSTRAINT "asset_readings_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "asset_readings" ADD CONSTRAINT "asset_readings_asset_fkey"
  FOREIGN KEY ("tenant_id", "asset_id") REFERENCES "assets"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "asset_readings" ADD CONSTRAINT "asset_readings_run_fkey"
  FOREIGN KEY ("tenant_id", "run_id") REFERENCES "checklist_runs"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "asset_readings" ADD CONSTRAINT "asset_readings_metric_shape"
  CHECK ("metric_key" ~ '^[a-z][a-z0-9_]{1,39}$' AND ("unit" IS NULL OR char_length("unit") BETWEEN 1 AND 16));
ALTER TABLE "asset_readings" ADD CONSTRAINT "asset_readings_source_shape"
  CHECK (("source" = 'run' AND "run_id" IS NOT NULL) OR ("source" = 'manual' AND "run_id" IS NULL));
CREATE TRIGGER "asset_readings_immutable_rows" BEFORE UPDATE OR DELETE ON "asset_readings"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER "asset_readings_immutable_truncate" BEFORE TRUNCATE ON "asset_readings"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- Who acted, in the same compound (composite keys, like every other
-- reference; an erasure nulls a person's columns, it deletes no account).
ALTER TABLE "checklist_runs" ADD CONSTRAINT "checklist_runs_submitted_by_fkey"
  FOREIGN KEY ("tenant_id", "submitted_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "checklist_answers" ADD CONSTRAINT "checklist_answers_answered_by_fkey"
  FOREIGN KEY ("tenant_id", "answered_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "asset_readings" ADD CONSTRAINT "asset_readings_recorded_by_fkey"
  FOREIGN KEY ("tenant_id", "recorded_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

REVOKE ALL ON "checklist_templates", "checklist_template_items", "checklist_runs",
  "checklist_answers", "checklist_answer_photos", "asset_readings" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "checklist_templates", "checklist_runs", "checklist_answers" TO jiwar_app;
GRANT SELECT, INSERT ON "checklist_template_items", "checklist_answer_photos", "asset_readings" TO jiwar_app;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['checklist_templates', 'checklist_template_items', 'checklist_runs',
                           'checklist_answers', 'checklist_answer_photos', 'asset_readings'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
