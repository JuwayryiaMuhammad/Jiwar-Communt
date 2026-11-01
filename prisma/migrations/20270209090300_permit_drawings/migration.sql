-- ============================================================================
-- Fit-out completion (ADR 0074): a works permit's drawings.
-- ============================================================================
--
-- The requester of a works permit, or the unit's primary, joins up to ten
-- drawings of the works (a `permit_drawing` file: an image or a PDF) while
-- the permit is pending or approved and has not ended, and takes one off;
-- the management reads them with the permit. A works permit only (the
-- composite key on its kind). A drawing is taken off once and never
-- deleted: its file stays the record's.

CREATE TABLE "permit_drawings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "permit_id" UUID NOT NULL,
    "permit_kind" "unit_permit_kind" NOT NULL DEFAULT 'works',
    "file_id" UUID NOT NULL,
    "added_by" UUID NOT NULL,
    "added_at" TIMESTAMPTZ(3) NOT NULL,
    "removed_at" TIMESTAMPTZ(3),
    "removed_by" UUID,
    CONSTRAINT "permit_drawings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "permit_drawings_tenant_id_id_key" ON "permit_drawings"("tenant_id", "id");
CREATE UNIQUE INDEX "permit_drawings_file_id_key" ON "permit_drawings"("file_id");
CREATE INDEX "permit_drawings_permit_idx" ON "permit_drawings"("tenant_id", "permit_id", "added_at");
ALTER TABLE "permit_drawings"
  ADD CONSTRAINT "permit_drawings_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "permit_drawings_permit_fkey"
  FOREIGN KEY ("tenant_id", "permit_id", "permit_kind")
  REFERENCES "unit_permits"("tenant_id", "id", "kind")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "permit_drawings_file_fkey"
  FOREIGN KEY ("tenant_id", "file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "permit_drawings_added_by_fkey"
  FOREIGN KEY ("tenant_id", "added_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "permit_drawings_removed_by_fkey"
  FOREIGN KEY ("tenant_id", "removed_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "permit_drawings" ADD CONSTRAINT "permit_drawings_shape"
  CHECK ("permit_kind" = 'works'
     AND ("removed_at" IS NULL) = ("removed_by" IS NULL)
     AND ("removed_at" IS NULL OR "removed_at" >= "added_at"));

-- What was added never changes; a drawing is taken off once; nothing goes.
CREATE FUNCTION permit_drawing_removed_once() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."permit_id" = OLD."permit_id"
     AND NEW."permit_kind" = OLD."permit_kind"
     AND NEW."file_id" = OLD."file_id"
     AND NEW."added_by" = OLD."added_by"
     AND NEW."added_at" = OLD."added_at"
     AND OLD."removed_at" IS NULL AND NEW."removed_at" IS NOT NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'permit_drawings: a drawing keeps what was added, is taken off once and never goes (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER permit_drawings_removed_once
  BEFORE UPDATE OR DELETE ON "permit_drawings"
  FOR EACH ROW EXECUTE FUNCTION permit_drawing_removed_once();
CREATE TRIGGER permit_drawings_no_truncate
  BEFORE TRUNCATE ON "permit_drawings"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

GRANT SELECT, INSERT, UPDATE ON "permit_drawings" TO jiwar_app;
ALTER TABLE "permit_drawings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "permit_drawings" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "permit_drawings"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
