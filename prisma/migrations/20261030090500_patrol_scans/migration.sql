-- ============================================================================
-- Patrols (ADR 0052): scans and notes.
-- ============================================================================
--
-- A scan says a guard was at a checkpoint during a run: by its QR, its NFC
-- tag (the same payload) or by hand with a reason's code. Its id is the
-- app's (UUIDv7), so a retry records once; `scanned_at` is the device's
-- time, `received_at` the server's. A scan farther from the checkpoint
-- than its radius is kept and flagged. Each checkpoint once per run. Scans
-- are their own immutable log, like the gate's entries.
--
-- A note at a scanned checkpoint: an outcome's code, the guard's words
-- (gone when the guard is erased) and up to three photos, which stay: they
-- show a place.

CREATE TYPE "patrol_scan_method" AS ENUM ('qr', 'nfc', 'manual');

CREATE TABLE "patrol_scans" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "checkpoint_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "method" "patrol_scan_method" NOT NULL,
    "manual_reason" TEXT,
    "scanned_at" TIMESTAMPTZ(3) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "accuracy_m" DOUBLE PRECISION,
    "distance_m" INTEGER,
    "position_suspect" BOOLEAN,
    "guard_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patrol_scans_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "patrol_scans_tenant_id_id_key" ON "patrol_scans"("tenant_id", "id");
-- Each checkpoint once per run.
CREATE UNIQUE INDEX "patrol_scans_once_per_checkpoint"
  ON "patrol_scans"("tenant_id", "run_id", "checkpoint_id");
CREATE INDEX "patrol_scans_run_idx" ON "patrol_scans"("tenant_id", "run_id", "scanned_at");
CREATE INDEX "patrol_scans_guard_idx" ON "patrol_scans"("tenant_id", "guard_account_id");

ALTER TABLE "patrol_scans"
  ADD CONSTRAINT "patrol_scans_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "patrol_scans_tenant_id_run_id_fkey"
    FOREIGN KEY ("tenant_id", "run_id") REFERENCES "patrol_runs"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "patrol_scans_tenant_id_checkpoint_id_fkey"
    FOREIGN KEY ("tenant_id", "checkpoint_id") REFERENCES "patrol_checkpoints"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "patrol_scans_tenant_id_guard_account_id_fkey"
    FOREIGN KEY ("tenant_id", "guard_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "patrol_scans"
  ADD CONSTRAINT "patrol_scans_position_range"
    CHECK ("position" BETWEEN 1 AND 50),
  -- By hand exactly when a reason's code says why.
  ADD CONSTRAINT "patrol_scans_manual_shape"
    CHECK (("method" = 'manual') = ("manual_reason" IS NOT NULL)
           AND ("manual_reason" IS NULL OR "manual_reason" IN ('qr_damaged', 'qr_missing', 'nfc_unreadable', 'other'))),
  -- Where the device was: a latitude and a longitude together, its
  -- accuracy only with them.
  ADD CONSTRAINT "patrol_scans_position_shape"
    CHECK (("lat" IS NULL) = ("lng" IS NULL)
           AND ("lat" IS NULL OR ("lat" BETWEEN -90 AND 90 AND "lng" BETWEEN -180 AND 180))
           AND ("accuracy_m" IS NULL OR ("lat" IS NOT NULL AND "accuracy_m" BETWEEN 0 AND 10000))),
  -- The distance and the flag together, only when both sides had a position.
  ADD CONSTRAINT "patrol_scans_distance_shape"
    CHECK (("distance_m" IS NULL) = ("position_suspect" IS NULL)
           AND ("distance_m" IS NULL OR ("lat" IS NOT NULL AND "distance_m" >= 0)));

CREATE TRIGGER patrol_scans_immutable
  BEFORE UPDATE OR DELETE ON "patrol_scans"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER patrol_scans_immutable_truncate
  BEFORE TRUNCATE ON "patrol_scans"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

CREATE TABLE "patrol_notes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "scan_id" UUID NOT NULL,
    "outcome" TEXT NOT NULL,
    "text" TEXT,
    "noted_at" TIMESTAMPTZ(3) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL,
    "guard_account_id" UUID NOT NULL,
    "text_cleared_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patrol_notes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "patrol_notes_tenant_id_id_key" ON "patrol_notes"("tenant_id", "id");
-- One note per scan.
CREATE UNIQUE INDEX "patrol_notes_scan_key" ON "patrol_notes"("tenant_id", "scan_id");
CREATE INDEX "patrol_notes_run_idx" ON "patrol_notes"("tenant_id", "run_id");
CREATE INDEX "patrol_notes_guard_idx" ON "patrol_notes"("tenant_id", "guard_account_id")
  WHERE "text" IS NOT NULL;

ALTER TABLE "patrol_notes"
  ADD CONSTRAINT "patrol_notes_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "patrol_notes_tenant_id_run_id_fkey"
    FOREIGN KEY ("tenant_id", "run_id") REFERENCES "patrol_runs"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "patrol_notes_tenant_id_scan_id_fkey"
    FOREIGN KEY ("tenant_id", "scan_id") REFERENCES "patrol_scans"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "patrol_notes_tenant_id_guard_account_id_fkey"
    FOREIGN KEY ("tenant_id", "guard_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "patrol_notes"
  ADD CONSTRAINT "patrol_notes_outcome"
    CHECK ("outcome" IN ('all_clear', 'issue_found')),
  ADD CONSTRAINT "patrol_notes_text_length"
    CHECK ("text" IS NULL OR char_length("text") BETWEEN 1 AND 1000),
  ADD CONSTRAINT "patrol_notes_cleared_shape"
    CHECK ("text_cleared_at" IS NULL OR "text" IS NULL);

-- What a note says never changes; its words go once (an erasure), with the
-- moment they went. Never deleted.
CREATE FUNCTION patrol_note_is_kept() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."run_id" = OLD."run_id"
     AND NEW."scan_id" = OLD."scan_id"
     AND NEW."outcome" = OLD."outcome"
     AND NEW."noted_at" = OLD."noted_at"
     AND NEW."received_at" = OLD."received_at"
     AND NEW."guard_account_id" = OLD."guard_account_id"
     AND NEW."created_at" = OLD."created_at"
     AND OLD."text" IS NOT NULL AND NEW."text" IS NULL
     AND OLD."text_cleared_at" IS NULL AND NEW."text_cleared_at" IS NOT NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'patrol_notes: what a note says never changes; its words go once and it is never deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER patrol_notes_kept
  BEFORE UPDATE OR DELETE ON "patrol_notes"
  FOR EACH ROW EXECUTE FUNCTION patrol_note_is_kept();
CREATE TRIGGER patrol_notes_kept_truncate
  BEFORE TRUNCATE ON "patrol_notes"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

CREATE TABLE "patrol_note_photos" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "note_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "uploaded_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patrol_note_photos_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "patrol_note_photos_tenant_id_id_key" ON "patrol_note_photos"("tenant_id", "id");
CREATE UNIQUE INDEX "patrol_note_photos_file_id_key" ON "patrol_note_photos"("file_id");
CREATE INDEX "patrol_note_photos_note_idx" ON "patrol_note_photos"("tenant_id", "note_id");
ALTER TABLE "patrol_note_photos"
  ADD CONSTRAINT "patrol_note_photos_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "patrol_note_photos_tenant_id_note_id_fkey"
    FOREIGN KEY ("tenant_id", "note_id") REFERENCES "patrol_notes"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "patrol_note_photos_tenant_id_file_id_fkey"
    FOREIGN KEY ("tenant_id", "file_id") REFERENCES "files"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "patrol_note_photos_tenant_id_uploaded_by_account_id_fkey"
    FOREIGN KEY ("tenant_id", "uploaded_by_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE TRIGGER patrol_note_photos_immutable
  BEFORE UPDATE OR DELETE ON "patrol_note_photos"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER patrol_note_photos_immutable_truncate
  BEFORE TRUNCATE ON "patrol_note_photos"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "patrol_scans", "patrol_notes", "patrol_note_photos" FROM jiwar_app;
GRANT SELECT, INSERT ON "patrol_scans", "patrol_note_photos" TO jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "patrol_notes" TO jiwar_app;

ALTER TABLE "patrol_scans" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "patrol_scans" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "patrol_scans"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "patrol_notes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "patrol_notes" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "patrol_notes"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "patrol_note_photos" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "patrol_note_photos" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "patrol_note_photos"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
