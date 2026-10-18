-- ============================================================================
-- Security (ADR 0053): the blocklist and the watchlist.
--
-- An entry names a plate (`plate_key`, folded as every plate key, ADR 0045,
-- 0047) or a person: a name, the full ID number only as a peppered HMAC
-- bound to the compound (never the number), and an optional face. `ban`
-- refuses at the gate; `watch` lets in and tells the management.
--
-- * One live entry per plate key and per ID hash, checked under the
--   compound's blocklist lock, with a partial unique index behind each.
-- * Its subject never changes; kind, reason, note, expiry and photo do
--   while it is live. It is lifted once (by the management, or by the
--   system once expired), and 30 days after a person's entry was lifted
--   its personal data goes, once (`purged_at`). Never deleted.
-- ============================================================================

CREATE TABLE "blocklist_entries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "plate" TEXT,
    "plate_key" TEXT GENERATED ALWAYS AS (translate(replace("plate", ' ', ''), '٠١٢٣٤٥٦٧٨٩أإآىة', '0123456789ااايه')) STORED,
    "full_name" TEXT,
    -- hex(HMAC-SHA256(pepper, "blocklist-id:v1:<tenant>:<normalized number>")).
    "id_hash" CHAR(64),
    "photo_file_id" UUID,
    "reason_code" TEXT NOT NULL,
    -- The management's words: never a guard's, never a resident's.
    "note" TEXT,
    "expires_at" TIMESTAMPTZ(3),
    "created_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lifted_at" TIMESTAMPTZ(3),
    -- NULL when the system lifted it (expired).
    "lifted_by_account_id" UUID,
    "lift_reason" TEXT,
    "purged_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "blocklist_entries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "blocklist_entries_tenant_id_id_key" ON "blocklist_entries"("tenant_id", "id");
-- One live entry per plate and per person.
CREATE UNIQUE INDEX "blocklist_entries_live_plate_key"
  ON "blocklist_entries"("tenant_id", "plate_key")
  WHERE "lifted_at" IS NULL AND "subject" = 'plate';
CREATE UNIQUE INDEX "blocklist_entries_live_id_key"
  ON "blocklist_entries"("tenant_id", "id_hash")
  WHERE "lifted_at" IS NULL AND "subject" = 'person';
CREATE UNIQUE INDEX "blocklist_entries_photo_key" ON "blocklist_entries"("photo_file_id");
CREATE INDEX "blocklist_entries_list_idx"
  ON "blocklist_entries"("tenant_id", "created_at", "id");
-- What the purge reads.
CREATE INDEX "blocklist_entries_lifted_idx"
  ON "blocklist_entries"("tenant_id", "lifted_at")
  WHERE "subject" = 'person' AND "purged_at" IS NULL AND "lifted_at" IS NOT NULL;
ALTER TABLE "blocklist_entries"
  ADD CONSTRAINT "blocklist_entries_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "blocklist_entries_tenant_id_photo_fkey"
  FOREIGN KEY ("tenant_id", "photo_file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "blocklist_entries_tenant_id_created_by_fkey"
  FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "blocklist_entries_tenant_id_lifted_by_fkey"
  FOREIGN KEY ("tenant_id", "lifted_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "blocklist_entries" ADD CONSTRAINT "blocklist_entries_kind"
  CHECK ("kind" IN ('ban', 'watch'));
-- A plate entry carries a plate and nothing of a person; a person's carries
-- a name and an ID hash until its purge, never a plate.
ALTER TABLE "blocklist_entries" ADD CONSTRAINT "blocklist_entries_subject_shape"
  CHECK (("subject" = 'plate'
          AND "plate" IS NOT NULL
          AND "full_name" IS NULL AND "id_hash" IS NULL AND "photo_file_id" IS NULL
          AND "purged_at" IS NULL)
      OR ("subject" = 'person'
          AND "plate" IS NULL
          AND ("purged_at" IS NOT NULL
               OR ("full_name" IS NOT NULL AND "id_hash" IS NOT NULL))));
ALTER TABLE "blocklist_entries" ADD CONSTRAINT "blocklist_entries_plate_length"
  CHECK ("plate" IS NULL OR char_length("plate") BETWEEN 1 AND 12);
ALTER TABLE "blocklist_entries" ADD CONSTRAINT "blocklist_entries_name_length"
  CHECK ("full_name" IS NULL OR char_length("full_name") BETWEEN 2 AND 120);
ALTER TABLE "blocklist_entries" ADD CONSTRAINT "blocklist_entries_id_hash_shape"
  CHECK ("id_hash" IS NULL OR "id_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "blocklist_entries" ADD CONSTRAINT "blocklist_entries_note_length"
  CHECK ("note" IS NULL OR char_length("note") BETWEEN 1 AND 1000);
-- REASON_CODES.blocklistReason, blocklistLift and blocklistLiftSystem; a
-- unit test keeps them in step.
ALTER TABLE "blocklist_entries" ADD CONSTRAINT "blocklist_entries_reason"
  CHECK ("reason_code" IN ('trespassing', 'theft', 'violence', 'harassment', 'fraud', 'vandalism', 'police_request', 'management_decision', 'other'));
-- Lifted: when and why together; by someone, or by the system once expired.
ALTER TABLE "blocklist_entries" ADD CONSTRAINT "blocklist_entries_lift_shape"
  CHECK (("lifted_at" IS NULL) = ("lift_reason" IS NULL)
     AND ("lift_reason" IS NULL
          OR ("lift_reason" = 'expired' AND "lifted_by_account_id" IS NULL)
          OR ("lift_reason" IN ('resolved', 'entered_in_error', 'other')
              AND "lifted_by_account_id" IS NOT NULL))
     AND ("lifted_by_account_id" IS NULL OR "lifted_at" IS NOT NULL));
-- Purged: only once lifted, and then nothing of the person is left.
ALTER TABLE "blocklist_entries" ADD CONSTRAINT "blocklist_entries_purge_shape"
  CHECK ("purged_at" IS NULL
      OR ("lifted_at" IS NOT NULL
          AND "full_name" IS NULL AND "id_hash" IS NULL
          AND "photo_file_id" IS NULL AND "note" IS NULL));

-- What an entry is about never changes; it is lifted once and purged once;
-- a purged one never changes again. Never deleted.
CREATE FUNCTION blocklist_entry_keeps_its_subject() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."subject" = OLD."subject"
     AND NEW."plate" IS NOT DISTINCT FROM OLD."plate"
     AND NEW."created_by_account_id" = OLD."created_by_account_id"
     AND NEW."created_at" = OLD."created_at"
     AND OLD."purged_at" IS NULL
     AND (
       -- Live: what it says may change, the person stays the person.
       (OLD."lifted_at" IS NULL
        AND NEW."full_name" IS NOT DISTINCT FROM OLD."full_name"
        AND NEW."id_hash" IS NOT DISTINCT FROM OLD."id_hash"
        AND NEW."purged_at" IS NULL)
       -- Lifted: nothing changes but the one purge.
       OR (OLD."lifted_at" IS NOT NULL
           AND NEW."lifted_at" = OLD."lifted_at"
           AND NEW."lifted_by_account_id" IS NOT DISTINCT FROM OLD."lifted_by_account_id"
           AND NEW."lift_reason" = OLD."lift_reason"
           AND NEW."kind" = OLD."kind"
           AND NEW."reason_code" = OLD."reason_code"
           AND NEW."expires_at" IS NOT DISTINCT FROM OLD."expires_at"
           AND NEW."purged_at" IS NOT NULL)
     ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'blocklist_entries: an entry keeps its subject, is lifted and purged once, and is never deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER blocklist_entries_keep_subject
  BEFORE UPDATE OR DELETE ON "blocklist_entries"
  FOR EACH ROW EXECUTE FUNCTION blocklist_entry_keeps_its_subject();
CREATE TRIGGER blocklist_entries_keep_subject_truncate
  BEFORE TRUNCATE ON "blocklist_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "blocklist_entries" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "blocklist_entries" TO jiwar_app;
ALTER TABLE "blocklist_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "blocklist_entries" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "blocklist_entries"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
