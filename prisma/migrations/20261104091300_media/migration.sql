-- ============================================================================
-- Recordings (ADR 0056): a patrol note's or an incident's sound or video.
--
-- - Four purposes: `patrol_note_audio` and `incident_audio` take
--   `audio/mp4` (20 MB at most); `patrol_note_video` and `incident_video`
--   take `video/mp4` or `video/quicktime` (100 MB at most). The MP4 family
--   only: its duration is read from the container at finalize. No image
--   for them, no recording for any other purpose. Both CHECKs are recreated
--   with every purpose (R7b's three of 20261102090100 included).
-- - `files.media_duration_ms`: a recording's length, read at finalize;
--   only a recording has one, and a finalized recording always does.
-- - `gate_settings`: what the compound allows, under the system's caps —
--   audio_max_seconds (300; 10 to 600), video_max_seconds (120; 10 to 300),
--   audio_max_mb (20; 1 to 20), video_max_mb (100; 1 to 100). Checked when
--   a recording is attached.
-- - `patrol_note_media`, `incident_media`: a note's or an incident's
--   recordings, attached with it, its kind and length copied; only ever
--   added. Kept as their parent is.
-- ============================================================================

ALTER TABLE "files" DROP CONSTRAINT "files_content_type_for_purpose";
ALTER TABLE "files" ADD CONSTRAINT "files_content_type_for_purpose"
  CHECK (("content_type" IN ('image/jpeg', 'image/png', 'image/webp') AND "purpose" NOT IN ('data_export', 'patrol_note_audio', 'patrol_note_video', 'incident_audio', 'incident_video'))
      OR ("content_type" = 'application/pdf' AND "purpose" IN ('document', 'request_attachment', 'community_attachment', 'complaint_evidence', 'vehicle_licence', 'approval_attachment', 'board_appeal_attachment', 'expense_invoice'))
      OR ("content_type" = 'application/zip' AND "purpose" = 'data_export')
      OR ("content_type" = 'audio/mp4' AND "purpose" IN ('patrol_note_audio', 'incident_audio'))
      OR ("content_type" IN ('video/mp4', 'video/quicktime') AND "purpose" IN ('patrol_note_video', 'incident_video')));
ALTER TABLE "files" DROP CONSTRAINT "files_size_for_purpose";
ALTER TABLE "files" ADD CONSTRAINT "files_size_for_purpose"
  CHECK ("size_bytes" > 0 AND "size_bytes" <= CASE "purpose"
           WHEN 'worker_photo' THEN 5242880
           WHEN 'resident_photo' THEN 5242880
           WHEN 'ticket_photo' THEN 5242880
           WHEN 'parcel_photo' THEN 5242880
           WHEN 'neighbour_post_photo' THEN 5242880
           WHEN 'gate_request_photo' THEN 5242880
           WHEN 'parking_photo' THEN 5242880
           WHEN 'vehicle_fine_photo' THEN 5242880
           WHEN 'gate_service_photo' THEN 5242880
           WHEN 'dispute_photo' THEN 5242880
           WHEN 'contractor_photo' THEN 5242880
           WHEN 'permit_photo' THEN 5242880
           WHEN 'guard_task_photo' THEN 5242880
           WHEN 'found_item_photo' THEN 5242880
           WHEN 'patrol_photo' THEN 5242880
           WHEN 'incident_photo' THEN 5242880
           WHEN 'blocklist_photo' THEN 5242880
           WHEN 'violation_photo' THEN 5242880
           WHEN 'violation_appeal_photo' THEN 5242880
           WHEN 'child_photo' THEN 5242880
           WHEN 'child_escort_photo' THEN 5242880
           WHEN 'visitor_photo' THEN 5242880
           WHEN 'patrol_note_audio' THEN 20971520
           WHEN 'patrol_note_video' THEN 104857600
           WHEN 'incident_audio' THEN 20971520
           WHEN 'incident_video' THEN 104857600
           WHEN 'data_export' THEN 536870912
           ELSE 10485760 END);

ALTER TABLE "files" ADD COLUMN "media_duration_ms" INTEGER;
ALTER TABLE "files" ADD CONSTRAINT "files_media_duration"
  CHECK (("media_duration_ms" IS NULL OR "media_duration_ms" > 0)
         AND ("media_duration_ms" IS NULL
              OR "purpose" IN ('patrol_note_audio', 'patrol_note_video', 'incident_audio', 'incident_video'))
         AND ("status" <> 'ready' OR "media_duration_ms" IS NOT NULL
              OR "purpose" NOT IN ('patrol_note_audio', 'patrol_note_video', 'incident_audio', 'incident_video')));

ALTER TABLE "gate_settings"
  ADD COLUMN "audio_max_seconds" SMALLINT NOT NULL DEFAULT 300,
  ADD COLUMN "video_max_seconds" SMALLINT NOT NULL DEFAULT 120,
  ADD COLUMN "audio_max_mb" SMALLINT NOT NULL DEFAULT 20,
  ADD COLUMN "video_max_mb" SMALLINT NOT NULL DEFAULT 100;
ALTER TABLE "gate_settings"
  ADD CONSTRAINT "gate_settings_audio_seconds" CHECK ("audio_max_seconds" BETWEEN 10 AND 600),
  ADD CONSTRAINT "gate_settings_video_seconds" CHECK ("video_max_seconds" BETWEEN 10 AND 300),
  ADD CONSTRAINT "gate_settings_audio_mb" CHECK ("audio_max_mb" BETWEEN 1 AND 20),
  ADD CONSTRAINT "gate_settings_video_mb" CHECK ("video_max_mb" BETWEEN 1 AND 100);

CREATE TABLE "patrol_note_media" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "note_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "uploaded_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "patrol_note_media_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "patrol_note_media_tenant_id_id_key" ON "patrol_note_media"("tenant_id", "id");
CREATE UNIQUE INDEX "patrol_note_media_file_key" ON "patrol_note_media"("tenant_id", "file_id");
CREATE INDEX "patrol_note_media_parent_idx" ON "patrol_note_media"("tenant_id", "note_id");
ALTER TABLE "patrol_note_media"
  ADD CONSTRAINT "patrol_note_media_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "patrol_note_media_parent_fkey"
    FOREIGN KEY ("tenant_id", "note_id") REFERENCES "patrol_notes"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "patrol_note_media_file_fkey"
    FOREIGN KEY ("tenant_id", "file_id") REFERENCES "files"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "patrol_note_media_by_fkey"
    FOREIGN KEY ("tenant_id", "uploaded_by_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "patrol_note_media_kind" CHECK ("kind" IN ('audio', 'video')),
  ADD CONSTRAINT "patrol_note_media_duration" CHECK ("duration_ms" > 0);
CREATE TRIGGER patrol_note_media_immutable_rows
  BEFORE UPDATE OR DELETE ON "patrol_note_media"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER patrol_note_media_immutable_truncate
  BEFORE TRUNCATE ON "patrol_note_media"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();
REVOKE ALL ON "patrol_note_media" FROM jiwar_app;
GRANT SELECT, INSERT ON "patrol_note_media" TO jiwar_app;
ALTER TABLE "patrol_note_media" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "patrol_note_media" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "patrol_note_media"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE "incident_media" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "incident_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "uploaded_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "incident_media_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "incident_media_tenant_id_id_key" ON "incident_media"("tenant_id", "id");
CREATE UNIQUE INDEX "incident_media_file_key" ON "incident_media"("tenant_id", "file_id");
CREATE INDEX "incident_media_parent_idx" ON "incident_media"("tenant_id", "incident_id");
ALTER TABLE "incident_media"
  ADD CONSTRAINT "incident_media_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "incident_media_parent_fkey"
    FOREIGN KEY ("tenant_id", "incident_id") REFERENCES "incidents"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "incident_media_file_fkey"
    FOREIGN KEY ("tenant_id", "file_id") REFERENCES "files"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "incident_media_by_fkey"
    FOREIGN KEY ("tenant_id", "uploaded_by_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "incident_media_kind" CHECK ("kind" IN ('audio', 'video')),
  ADD CONSTRAINT "incident_media_duration" CHECK ("duration_ms" > 0);
CREATE TRIGGER incident_media_immutable_rows
  BEFORE UPDATE OR DELETE ON "incident_media"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER incident_media_immutable_truncate
  BEFORE TRUNCATE ON "incident_media"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();
REVOKE ALL ON "incident_media" FROM jiwar_app;
GRANT SELECT, INSERT ON "incident_media" TO jiwar_app;
ALTER TABLE "incident_media" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "incident_media" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "incident_media"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
