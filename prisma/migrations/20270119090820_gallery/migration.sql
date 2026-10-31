-- ============================================================================
-- Daily life (ADR 0071): the compound's gallery — albums of photos the staff
-- upload (`content.manage`), an event's or not, which residents see once
-- published. A resident reports a photo; a privacy report hides it at once,
-- pending the staff, who restore it or keep it hidden with a code. A hidden
-- photo is never shown, published or not.
-- ============================================================================

CREATE TABLE "gallery_albums" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "title_en" TEXT NOT NULL,
    "title_ar" TEXT NOT NULL,
    "event_id" UUID,
    "published_at" TIMESTAMPTZ(3),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "gallery_albums_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "gallery_albums_tenant_id_id_key" ON "gallery_albums"("tenant_id", "id");
CREATE INDEX "gallery_albums_published_idx"
  ON "gallery_albums"("tenant_id", "published_at" DESC, "id" DESC);
ALTER TABLE "gallery_albums"
  ADD CONSTRAINT "gallery_albums_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gallery_albums_tenant_id_event_fkey"
  FOREIGN KEY ("tenant_id", "event_id") REFERENCES "community_events"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gallery_albums_tenant_id_created_by_fkey"
  FOREIGN KEY ("tenant_id", "created_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "gallery_albums" ADD CONSTRAINT "gallery_albums_title_length"
  CHECK (char_length("title_en") BETWEEN 1 AND 120 AND char_length("title_ar") BETWEEN 1 AND 120);

-- Published once, for good; the event and the author never change.
CREATE FUNCTION gallery_album_publishes_once() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."event_id" IS NOT DISTINCT FROM OLD."event_id"
     AND NEW."created_by" = OLD."created_by"
     AND NEW."created_at" = OLD."created_at"
     AND (OLD."published_at" IS NULL
          OR NEW."published_at" IS NOT DISTINCT FROM OLD."published_at") THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'gallery_albums: an album keeps its event and stays published (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER gallery_albums_publish_once
  BEFORE UPDATE OR DELETE ON "gallery_albums"
  FOR EACH ROW EXECUTE FUNCTION gallery_album_publishes_once();
CREATE TRIGGER gallery_albums_publish_once_truncate
  BEFORE TRUNCATE ON "gallery_albums"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- A photo: visible or hidden, the hiding's code (`privacy_report` when a
-- resident's privacy report hid it, else a `galleryPhotoHide` code).
CREATE TABLE "gallery_photos" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "album_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "caption" TEXT,
    "hidden_at" TIMESTAMPTZ(3),
    "hidden_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "gallery_photos_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "gallery_photos_tenant_id_id_key" ON "gallery_photos"("tenant_id", "id");
CREATE UNIQUE INDEX "gallery_photos_file_id_key" ON "gallery_photos"("file_id");
CREATE INDEX "gallery_photos_album_idx"
  ON "gallery_photos"("tenant_id", "album_id", "created_at", "id");
ALTER TABLE "gallery_photos"
  ADD CONSTRAINT "gallery_photos_tenant_id_album_fkey"
  FOREIGN KEY ("tenant_id", "album_id") REFERENCES "gallery_albums"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gallery_photos_tenant_id_file_fkey"
  FOREIGN KEY ("tenant_id", "file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "gallery_photos" ADD CONSTRAINT "gallery_photos_caption_length"
  CHECK ("caption" IS NULL OR char_length("caption") BETWEEN 1 AND 300);
ALTER TABLE "gallery_photos" ADD CONSTRAINT "gallery_photos_hidden_shape"
  CHECK (("hidden_at" IS NULL) = ("hidden_reason" IS NULL)
     AND ("hidden_reason" IS NULL OR "hidden_reason" IN
           ('privacy_report', 'privacy', 'inappropriate', 'other')));

-- A photo keeps its album and file; only its hiding changes.
CREATE FUNCTION gallery_photo_keeps_its_file() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."album_id" = OLD."album_id" AND NEW."file_id" = OLD."file_id"
     AND NEW."caption" IS NOT DISTINCT FROM OLD."caption"
     AND NEW."created_at" = OLD."created_at" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'gallery_photos: a photo keeps its album, its file and its caption (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER gallery_photos_keep_file
  BEFORE UPDATE OR DELETE ON "gallery_photos"
  FOR EACH ROW EXECUTE FUNCTION gallery_photo_keeps_its_file();
CREATE TRIGGER gallery_photos_keep_file_truncate
  BEFORE TRUNCATE ON "gallery_photos"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- A resident's report of a photo: once each. Never changes.
CREATE TABLE "gallery_photo_reports" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "photo_id" UUID NOT NULL,
    "reporter_account_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "gallery_photo_reports_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "gallery_photo_reports_tenant_id_id_key" ON "gallery_photo_reports"("tenant_id", "id");
CREATE UNIQUE INDEX "gallery_photo_reports_one_per_reporter"
  ON "gallery_photo_reports"("tenant_id", "photo_id", "reporter_account_id");
ALTER TABLE "gallery_photo_reports"
  ADD CONSTRAINT "gallery_photo_reports_tenant_id_photo_fkey"
  FOREIGN KEY ("tenant_id", "photo_id") REFERENCES "gallery_photos"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gallery_photo_reports_tenant_id_reporter_fkey"
  FOREIGN KEY ("tenant_id", "reporter_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "gallery_photo_reports" ADD CONSTRAINT "gallery_photo_reports_reason"
  CHECK ("reason" IN ('privacy', 'other'));
CREATE TRIGGER gallery_photo_reports_immutable_rows
  BEFORE UPDATE OR DELETE ON "gallery_photo_reports"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER gallery_photo_reports_immutable_truncate
  BEFORE TRUNCATE ON "gallery_photo_reports"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "gallery_albums", "gallery_photos", "gallery_photo_reports" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "gallery_albums", "gallery_photos" TO jiwar_app;
GRANT SELECT, INSERT ON "gallery_photo_reports" TO jiwar_app;
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['gallery_albums', 'gallery_photos', 'gallery_photo_reports'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
