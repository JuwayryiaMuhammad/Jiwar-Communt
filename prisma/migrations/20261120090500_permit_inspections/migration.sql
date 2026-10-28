-- ============================================================================
-- Works completion: the inspection and its certificate (ADR 0063)
-- ============================================================================
--
-- The requester of an approved works permit asks the management to inspect
-- the finished works. The management (`permits.manage`) records the
-- outcome once, with photos: failed, with findings from a closed list (the
-- requester fixes them and asks again: a new cycle), or passed, which
-- issues the completion certificate: a number, a verify code kept on the
-- row (as receipts' and clearances' are), the certificate template, and a
-- global pointer — the code's SHA-256 — for the public check. One
-- inspection asked and one passed per permit at most; a works permit only
-- (a composite foreign key on the permit's kind). The certificate is drawn
-- on demand from the row; nothing is stored but the record.

CREATE TABLE "permit_inspections" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "permit_id" UUID NOT NULL,
    "permit_kind" "unit_permit_kind" NOT NULL DEFAULT 'works',
    "cycle" INTEGER NOT NULL,
    "requested_by" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'asked',
    "decided_at" TIMESTAMPTZ(3),
    "decided_by" UUID,
    "findings" TEXT[] NOT NULL DEFAULT '{}',
    "certificate_number" INTEGER,
    "verify_code" CHAR(22),
    "template" TEXT,
    CONSTRAINT "permit_inspections_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "permit_inspections_tenant_id_id_key" ON "permit_inspections"("tenant_id", "id");
CREATE UNIQUE INDEX "permit_inspections_cycle_key" ON "permit_inspections"("permit_id", "cycle");
CREATE UNIQUE INDEX "permit_inspections_one_asked" ON "permit_inspections"("permit_id")
  WHERE "status" = 'asked';
CREATE UNIQUE INDEX "permit_inspections_one_passed" ON "permit_inspections"("permit_id")
  WHERE "status" = 'passed';
CREATE UNIQUE INDEX "permit_inspections_certificate_number_key"
  ON "permit_inspections"("tenant_id", "certificate_number") WHERE "certificate_number" IS NOT NULL;
CREATE UNIQUE INDEX "permit_inspections_verify_code_key"
  ON "permit_inspections"("verify_code") WHERE "verify_code" IS NOT NULL;
CREATE INDEX "permit_inspections_queue_idx" ON "permit_inspections"("tenant_id", "requested_at")
  WHERE "status" = 'asked';
ALTER TABLE "permit_inspections"
  ADD CONSTRAINT "permit_inspections_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "permit_inspections_permit_fkey"
  FOREIGN KEY ("tenant_id", "permit_id", "permit_kind")
  REFERENCES "unit_permits"("tenant_id", "id", "kind")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "permit_inspections_requested_by_fkey"
  FOREIGN KEY ("tenant_id", "requested_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "permit_inspections_decided_by_fkey"
  FOREIGN KEY ("tenant_id", "decided_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "permit_inspections" ADD CONSTRAINT "permit_inspections_shape"
  CHECK ("permit_kind" = 'works'
     AND "cycle" >= 1
     AND "status" IN ('asked', 'passed', 'failed')
     AND ("status" = 'asked') = ("decided_at" IS NULL)
     AND ("decided_at" IS NULL) = ("decided_by" IS NULL)
     AND ("decided_at" IS NULL OR "decided_at" >= "requested_at")
     -- A failure says what, from the closed list; a pass carries none.
     AND ("status" <> 'failed' OR cardinality("findings") BETWEEN 1 AND 5)
     AND ("status" = 'failed' OR cardinality("findings") = 0)
     AND "findings" <@ ARRAY['works_unfinished', 'common_areas_damaged', 'debris_left', 'safety_issue', 'other']::text[]
     -- The certificate is the pass's.
     AND ("status" = 'passed') = ("certificate_number" IS NOT NULL)
     AND ("certificate_number" IS NULL) = ("verify_code" IS NULL)
     AND ("certificate_number" IS NULL) = ("template" IS NULL)
     AND ("certificate_number" IS NULL OR "certificate_number" >= 1)
     AND ("verify_code" IS NULL OR "verify_code" ~ '^[A-Za-z0-9_-]{22}$')
     AND ("template" IS NULL OR "template" IN ('certificate.v2')));
CREATE FUNCTION permit_inspection_decided_once() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."permit_id" = OLD."permit_id"
     AND NEW."permit_kind" = OLD."permit_kind"
     AND NEW."cycle" = OLD."cycle"
     AND NEW."requested_by" = OLD."requested_by"
     AND NEW."requested_at" = OLD."requested_at"
     AND OLD."status" = 'asked' AND NEW."status" IN ('passed', 'failed') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'permit_inspections: an inspection is decided once and never changes or goes (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER permit_inspections_decided_once
  BEFORE UPDATE OR DELETE ON "permit_inspections"
  FOR EACH ROW EXECUTE FUNCTION permit_inspection_decided_once();
CREATE TRIGGER permit_inspections_no_truncate
  BEFORE TRUNCATE ON "permit_inspections"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- The inspection's photos: attached at its decision, never detached.
CREATE TABLE "permit_inspection_photos" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "inspection_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "permit_inspection_photos_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "permit_inspection_photos_file_id_key" ON "permit_inspection_photos"("file_id");
CREATE INDEX "permit_inspection_photos_inspection_idx"
  ON "permit_inspection_photos"("tenant_id", "inspection_id");
ALTER TABLE "permit_inspection_photos"
  ADD CONSTRAINT "permit_inspection_photos_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "permit_inspection_photos_inspection_fkey"
  FOREIGN KEY ("tenant_id", "inspection_id") REFERENCES "permit_inspections"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "permit_inspection_photos_file_fkey"
  FOREIGN KEY ("tenant_id", "file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE TRIGGER permit_inspection_photos_immutable
  BEFORE UPDATE OR DELETE ON "permit_inspection_photos"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER permit_inspection_photos_no_truncate
  BEFORE TRUNCATE ON "permit_inspection_photos"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

GRANT SELECT, INSERT, UPDATE ON "permit_inspections" TO jiwar_app;
GRANT SELECT, INSERT ON "permit_inspection_photos" TO jiwar_app;
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['permit_inspections', 'permit_inspection_photos'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- The public check's pointer: global, the code's SHA-256 and the record.
CREATE TABLE "works_certificate_links" (
    "code_hash" CHAR(64) NOT NULL,
    "tenant_id" UUID NOT NULL,
    "inspection_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "works_certificate_links_pkey" PRIMARY KEY ("code_hash")
);
ALTER TABLE "works_certificate_links"
  ADD CONSTRAINT "works_certificate_links_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "works_certificate_links_inspection_fkey"
  FOREIGN KEY ("tenant_id", "inspection_id") REFERENCES "permit_inspections"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "works_certificate_links" ADD CONSTRAINT "works_certificate_links_code_hash_hex"
  CHECK ("code_hash" ~ '^[0-9a-f]{64}$');
REVOKE ALL ON "works_certificate_links" FROM jiwar_app;
GRANT SELECT, INSERT ON "works_certificate_links" TO jiwar_app;
