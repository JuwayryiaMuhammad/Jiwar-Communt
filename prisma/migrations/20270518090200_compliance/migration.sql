-- ============================================================================
-- Compliance (ADR 0087): the compound's calendar of what it must keep valid —
-- its fire systems, its lifts, its insurance, its licences and permits —
-- each with who answers for it (a vendor of the register, a staff member,
-- or both), its due days, how often it recurs, when it is told ahead, and
-- an archive of its evidence.
--
-- * `compliance_settings`: the compound's lead times, the days ahead of a
--   due day its keepers and its responsible staff member are told (60, 30
--   and 7 by default). One row a compound, made by its first change; with
--   none the defaults hold.
-- * `compliance_items`: what is kept valid. A kind, a title, the authority
--   that issues it and its reference; what it is about (an asset of the
--   compound's own or a common area, or nothing: the compound); who answers
--   for it; every how many months it recurs; its own lead times, when they
--   differ from the compound's. Retired once, with a code; never deleted.
-- * `compliance_occurrences`: its due days. One open at a time (a partial
--   unique index behind the item's lock). Done once, on a day, with what it
--   gave (a certificate's number and its expiry) and a note about the work;
--   the next one is made then, due on that expiry or so many months on.
--   Called off once, when its item is retired.
-- * `compliance_evidence`: the files of a due day (`compliance_evidence`,
--   a photo or a PDF), through the files service. Removed once.
--
-- A vendor's papers (ADR 0077) are read into the calendar where they are,
-- never copied here. No personal data: the responsible staff member is a
-- reference, the words are about the work.
-- ============================================================================

CREATE TABLE "compliance_settings" (
    "tenant_id" UUID NOT NULL,
    "lead_days" SMALLINT[] NOT NULL DEFAULT ARRAY[60, 30, 7]::SMALLINT[],
    "updated_by_account_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "compliance_settings_pkey" PRIMARY KEY ("tenant_id")
);
ALTER TABLE "compliance_settings"
  ADD CONSTRAINT "compliance_settings_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "compliance_settings_tenant_id_updated_by_fkey"
  FOREIGN KEY ("tenant_id", "updated_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- One to three lead times, each 1 to 365 days, none NULL.
ALTER TABLE "compliance_settings" ADD CONSTRAINT "compliance_settings_lead_days"
  CHECK (cardinality("lead_days") BETWEEN 1 AND 3
     AND array_position("lead_days", NULL) IS NULL
     AND 1 <= ALL ("lead_days") AND 365 >= ALL ("lead_days"));

-- ----------------------------------------------------------------------------
-- What the compound keeps valid.
-- ----------------------------------------------------------------------------
CREATE TABLE "compliance_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "authority" TEXT,
    "reference" TEXT,
    "asset_id" UUID,
    "common_area_id" UUID,
    "vendor_id" UUID,
    "owner_account_id" UUID,
    "recurrence_months" SMALLINT,
    -- Empty: the compound's lead times.
    "lead_days" SMALLINT[] NOT NULL DEFAULT ARRAY[]::SMALLINT[],
    "notes" TEXT,
    "retired_at" TIMESTAMPTZ(3),
    "retired_by_account_id" UUID,
    "retire_reason" TEXT,
    "created_by_account_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "compliance_items_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "compliance_items_tenant_id_id_key" ON "compliance_items"("tenant_id", "id");
CREATE INDEX "compliance_items_list_idx"
  ON "compliance_items"("tenant_id", "kind", "created_at", "id");
CREATE INDEX "compliance_items_owner_idx"
  ON "compliance_items"("tenant_id", "owner_account_id")
  WHERE "owner_account_id" IS NOT NULL AND "retired_at" IS NULL;
CREATE INDEX "compliance_items_vendor_idx"
  ON "compliance_items"("tenant_id", "vendor_id")
  WHERE "vendor_id" IS NOT NULL;
ALTER TABLE "compliance_items"
  ADD CONSTRAINT "compliance_items_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "compliance_items_tenant_id_asset_fkey"
  FOREIGN KEY ("tenant_id", "asset_id") REFERENCES "assets"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "compliance_items_tenant_id_common_area_fkey"
  FOREIGN KEY ("tenant_id", "common_area_id") REFERENCES "common_areas"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "compliance_items_tenant_id_vendor_fkey"
  FOREIGN KEY ("tenant_id", "vendor_id") REFERENCES "vendors"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "compliance_items_tenant_id_owner_fkey"
  FOREIGN KEY ("tenant_id", "owner_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "compliance_items_tenant_id_retired_by_fkey"
  FOREIGN KEY ("tenant_id", "retired_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "compliance_items_tenant_id_created_by_fkey"
  FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- COMPLIANCE_KINDS in src/maintenance/compliance/compliance-rules.ts.
ALTER TABLE "compliance_items" ADD CONSTRAINT "compliance_items_kind_known"
  CHECK ("kind" IN ('fire_system', 'lift', 'insurance', 'licence', 'permit', 'other'));
ALTER TABLE "compliance_items" ADD CONSTRAINT "compliance_items_text_length"
  CHECK (char_length("title") BETWEEN 1 AND 120 AND "title" = btrim("title")
     AND ("authority" IS NULL OR char_length("authority") BETWEEN 1 AND 120)
     AND ("reference" IS NULL OR "reference" ~ '^[A-Za-z0-9/. -]{1,60}$')
     AND ("notes" IS NULL OR char_length("notes") BETWEEN 1 AND 1000));
-- About an asset, a common area, or the compound: at most one of them.
ALTER TABLE "compliance_items" ADD CONSTRAINT "compliance_items_one_subject"
  CHECK (num_nonnulls("asset_id", "common_area_id") <= 1);
-- Someone answers for it: a vendor, a staff member, or both.
ALTER TABLE "compliance_items" ADD CONSTRAINT "compliance_items_responsible"
  CHECK (num_nonnulls("vendor_id", "owner_account_id") >= 1);
-- Every 1 to 120 months, or once; its own lead times as the settings' are,
-- or none (the compound's).
ALTER TABLE "compliance_items" ADD CONSTRAINT "compliance_items_schedule"
  CHECK (("recurrence_months" IS NULL OR "recurrence_months" BETWEEN 1 AND 120)
     AND cardinality("lead_days") <= 3
     AND array_position("lead_days", NULL) IS NULL
     AND 1 <= ALL ("lead_days") AND 365 >= ALL ("lead_days"));
-- Retired with its time and a code from REASON_CODES.complianceRetire.
ALTER TABLE "compliance_items" ADD CONSTRAINT "compliance_items_retired_shape"
  CHECK (("retired_at" IS NULL) = ("retire_reason" IS NULL)
     AND ("retired_by_account_id" IS NULL OR "retired_at" IS NOT NULL)
     AND ("retire_reason" IS NULL
          OR "retire_reason" IN ('not_applicable', 'asset_retired', 'replaced', 'duplicate', 'other')));

-- An item keeps its kind and when it was made; retired once, it never
-- changes again. Never deleted.
CREATE FUNCTION compliance_items_retire_once() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."kind" = OLD."kind" AND NEW."created_at" = OLD."created_at"
     AND NEW."created_by_account_id" IS NOT DISTINCT FROM OLD."created_by_account_id"
     AND OLD."retired_at" IS NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'compliance_items: an item keeps its kind, is retired once and never deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER compliance_items_retire_once
  BEFORE UPDATE OR DELETE ON "compliance_items"
  FOR EACH ROW EXECUTE FUNCTION compliance_items_retire_once();
CREATE TRIGGER compliance_items_retire_once_truncate
  BEFORE TRUNCATE ON "compliance_items"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Its due days.
-- ----------------------------------------------------------------------------
CREATE TABLE "compliance_occurrences" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "due_on" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    -- The shortest lead time already told, and when its passing was told.
    "lead_alerted_days" SMALLINT,
    "overdue_notified_at" TIMESTAMPTZ(3),
    "done_on" DATE,
    "done_at" TIMESTAMPTZ(3),
    "done_by_account_id" UUID,
    "certificate_number" TEXT,
    "expires_on" DATE,
    "note" TEXT,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by_account_id" UUID,
    "previous_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "compliance_occurrences_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "compliance_occurrences_tenant_id_id_key"
  ON "compliance_occurrences"("tenant_id", "id");
-- One open due day an item: made and ended under the item's lock.
CREATE UNIQUE INDEX "compliance_occurrences_one_open"
  ON "compliance_occurrences"("tenant_id", "item_id")
  WHERE "status" = 'open';
CREATE INDEX "compliance_occurrences_item_idx"
  ON "compliance_occurrences"("tenant_id", "item_id", "due_on" DESC, "id" DESC);
-- What the calendar and the lead sweep read.
CREATE INDEX "compliance_occurrences_due_idx"
  ON "compliance_occurrences"("tenant_id", "due_on", "id")
  WHERE "status" = 'open';
ALTER TABLE "compliance_occurrences"
  ADD CONSTRAINT "compliance_occurrences_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "compliance_occurrences_tenant_id_item_fkey"
  FOREIGN KEY ("tenant_id", "item_id") REFERENCES "compliance_items"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "compliance_occurrences_tenant_id_done_by_fkey"
  FOREIGN KEY ("tenant_id", "done_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "compliance_occurrences_tenant_id_cancelled_by_fkey"
  FOREIGN KEY ("tenant_id", "cancelled_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "compliance_occurrences_tenant_id_previous_fkey"
  FOREIGN KEY ("tenant_id", "previous_id") REFERENCES "compliance_occurrences"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "compliance_occurrences" ADD CONSTRAINT "compliance_occurrences_status_known"
  CHECK ("status" IN ('open', 'done', 'cancelled'));
-- Done with its day, its time and its doer, and only then what it gave;
-- called off with its time. A certificate's expiry after the day it was
-- done; the lead mark one of the lead times.
ALTER TABLE "compliance_occurrences" ADD CONSTRAINT "compliance_occurrences_state_shape"
  CHECK (("status" = 'done') = ("done_at" IS NOT NULL)
     AND ("done_at" IS NULL) = ("done_on" IS NULL)
     AND ("done_at" IS NULL) = ("done_by_account_id" IS NULL)
     AND ("status" = 'cancelled') = ("cancelled_at" IS NOT NULL)
     AND ("cancelled_by_account_id" IS NULL OR "cancelled_at" IS NOT NULL)
     AND ("certificate_number" IS NULL
          OR ("done_at" IS NOT NULL AND "certificate_number" ~ '^[A-Za-z0-9/. -]{1,60}$'))
     AND ("expires_on" IS NULL OR ("done_on" IS NOT NULL AND "expires_on" > "done_on"))
     AND ("note" IS NULL OR ("done_at" IS NOT NULL AND char_length("note") BETWEEN 1 AND 1000))
     AND ("lead_alerted_days" IS NULL OR "lead_alerted_days" BETWEEN 1 AND 365)
     AND ("previous_id" IS NULL OR "previous_id" <> "id"));

-- A due day keeps its item and where it came from; while open its day may
-- move and its notices start again; done or called off once, it never
-- changes again. Never deleted.
CREATE FUNCTION compliance_occurrences_end_once() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."item_id" = OLD."item_id"
     AND NEW."previous_id" IS NOT DISTINCT FROM OLD."previous_id"
     AND NEW."created_at" = OLD."created_at"
     AND OLD."status" = 'open' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'compliance_occurrences: a due day is done or called off once and never deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER compliance_occurrences_end_once
  BEFORE UPDATE OR DELETE ON "compliance_occurrences"
  FOR EACH ROW EXECUTE FUNCTION compliance_occurrences_end_once();
CREATE TRIGGER compliance_occurrences_end_once_truncate
  BEFORE TRUNCATE ON "compliance_occurrences"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- The archive: a due day's files.
-- ----------------------------------------------------------------------------
CREATE TABLE "compliance_evidence" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "occurrence_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "added_by_account_id" UUID NOT NULL,
    "added_at" TIMESTAMPTZ(3) NOT NULL,
    "removed_at" TIMESTAMPTZ(3),
    "removed_by_account_id" UUID,
    CONSTRAINT "compliance_evidence_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "compliance_evidence_tenant_id_id_key" ON "compliance_evidence"("tenant_id", "id");
CREATE UNIQUE INDEX "compliance_evidence_file_key" ON "compliance_evidence"("tenant_id", "file_id");
CREATE INDEX "compliance_evidence_occurrence_idx"
  ON "compliance_evidence"("tenant_id", "occurrence_id", "added_at", "id");
ALTER TABLE "compliance_evidence"
  ADD CONSTRAINT "compliance_evidence_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "compliance_evidence_tenant_id_occurrence_fkey"
  FOREIGN KEY ("tenant_id", "occurrence_id") REFERENCES "compliance_occurrences"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "compliance_evidence_tenant_id_file_fkey"
  FOREIGN KEY ("tenant_id", "file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "compliance_evidence_tenant_id_added_by_fkey"
  FOREIGN KEY ("tenant_id", "added_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "compliance_evidence_tenant_id_removed_by_fkey"
  FOREIGN KEY ("tenant_id", "removed_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "compliance_evidence" ADD CONSTRAINT "compliance_evidence_removed_shape"
  CHECK (("removed_at" IS NULL) = ("removed_by_account_id" IS NULL));

-- A file is never edited: only removed once.
CREATE FUNCTION compliance_evidence_removed_once() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."occurrence_id" = OLD."occurrence_id" AND NEW."file_id" = OLD."file_id"
     AND NEW."added_by_account_id" = OLD."added_by_account_id"
     AND NEW."added_at" = OLD."added_at"
     AND OLD."removed_at" IS NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'compliance_evidence: a file is never edited, and is removed once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER compliance_evidence_removed_once
  BEFORE UPDATE OR DELETE ON "compliance_evidence"
  FOR EACH ROW EXECUTE FUNCTION compliance_evidence_removed_once();
CREATE TRIGGER compliance_evidence_removed_once_truncate
  BEFORE TRUNCATE ON "compliance_evidence"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Grants: each changes in place under FOR UPDATE (an item before its due
-- days). RLS, FORCE.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "compliance_settings", "compliance_items", "compliance_occurrences", "compliance_evidence" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "compliance_settings", "compliance_items", "compliance_occurrences", "compliance_evidence" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['compliance_settings', 'compliance_items', 'compliance_occurrences', 'compliance_evidence'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
