-- ============================================================================
-- Decision appeals (ADR 0059): a resident appeals a staff decision about
-- their unit to the management, within 15 days of it, once per decision: a
-- rejected permit, a rejected vehicle, a rejected worker, a neighbour
-- notice. Their grounds (cleared on their erasure) and up to three
-- attachments. A manager who did not take the decision upholds or
-- overturns it with a rationale (kept), the decider's role as it was named
-- then; an overturn is applied by the decision's domain through its normal
-- approval (`effect` applied), or left to the management (`follow_up`,
-- with the check that refused it, followed up once), or does nothing
-- (`none`). The appellant may withdraw it while pending. Numbered AP-.
--
-- `decision_appeal_attachment`: an image or a PDF, 10 MB at most. Both
-- file CHECKs are recreated with every purpose (20261104091500's text).
-- ============================================================================

ALTER TABLE "files" DROP CONSTRAINT "files_content_type_for_purpose";
ALTER TABLE "files" ADD CONSTRAINT "files_content_type_for_purpose"
  CHECK (("content_type" IN ('image/jpeg', 'image/png', 'image/webp') AND "purpose" NOT IN ('data_export', 'patrol_note_audio', 'patrol_note_video', 'incident_audio', 'incident_video', 'incident_signature'))
      OR ("content_type" = 'image/png' AND "purpose" = 'incident_signature')
      OR ("content_type" = 'application/pdf' AND "purpose" IN ('document', 'request_attachment', 'community_attachment', 'complaint_evidence', 'vehicle_licence', 'approval_attachment', 'board_appeal_attachment', 'expense_invoice', 'decision_appeal_attachment'))
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
           WHEN 'incident_signature' THEN 262144
           WHEN 'data_export' THEN 536870912
           ELSE 10485760 END);

CREATE TABLE "decision_appeal_counters" (
    "tenant_id" UUID NOT NULL,
    "last_number" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "decision_appeal_counters_pkey" PRIMARY KEY ("tenant_id")
);
ALTER TABLE "decision_appeal_counters"
  ADD CONSTRAINT "decision_appeal_counters_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "decision_appeal_counters" ADD CONSTRAINT "decision_appeal_counters_last_number_nonnegative"
  CHECK ("last_number" >= 0);

CREATE TABLE "decision_appeals" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "appellant_account_id" UUID NOT NULL,
    "grounds" TEXT,
    "grounds_cleared_at" TIMESTAMPTZ(3),
    "decision_at" TIMESTAMPTZ(3) NOT NULL,
    "decision_by_account_id" UUID,
    "lodged_at" TIMESTAMPTZ(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "decided_at" TIMESTAMPTZ(3),
    "decided_by_account_id" UUID,
    "decider_role_key" TEXT,
    "decider_role_name" TEXT,
    "rationale" TEXT,
    "withdrawn_at" TIMESTAMPTZ(3),
    "effect" TEXT,
    "effect_reason" TEXT,
    "followed_up_at" TIMESTAMPTZ(3),
    "followed_up_by_account_id" UUID,
    CONSTRAINT "decision_appeals_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "decision_appeals_tenant_id_id_key"
  ON "decision_appeals"("tenant_id", "id");
CREATE UNIQUE INDEX "decision_appeals_number_key"
  ON "decision_appeals"("tenant_id", "number");
-- One appeal per staff decision, ever.
CREATE UNIQUE INDEX "decision_appeals_one_per_decision"
  ON "decision_appeals"("tenant_id", "kind", "subject_id");
CREATE INDEX "decision_appeals_status_idx"
  ON "decision_appeals"("tenant_id", "status", "lodged_at", "id");
CREATE INDEX "decision_appeals_unit_idx"
  ON "decision_appeals"("tenant_id", "unit_id", "lodged_at", "id");
CREATE INDEX "decision_appeals_appellant_idx"
  ON "decision_appeals"("tenant_id", "appellant_account_id", "lodged_at", "id");
ALTER TABLE "decision_appeals"
  ADD CONSTRAINT "decision_appeals_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "decision_appeals_tenant_id_unit_id_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "decision_appeals_tenant_id_appellant_fkey"
  FOREIGN KEY ("tenant_id", "appellant_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "decision_appeals_tenant_id_decision_by_fkey"
  FOREIGN KEY ("tenant_id", "decision_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "decision_appeals_tenant_id_decided_by_fkey"
  FOREIGN KEY ("tenant_id", "decided_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "decision_appeals_tenant_id_followed_up_by_fkey"
  FOREIGN KEY ("tenant_id", "followed_up_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- DECISION_APPEAL_KINDS and DECISION_APPEAL_EFFECT_REASONS; a unit test
-- keeps them in step.
ALTER TABLE "decision_appeals" ADD CONSTRAINT "decision_appeals_kind"
  CHECK ("kind" IN ('permit_rejection', 'vehicle_rejection', 'worker_rejection', 'neighbour_notice'));
ALTER TABLE "decision_appeals" ADD CONSTRAINT "decision_appeals_number_positive"
  CHECK ("number" >= 1);
-- The grounds: words until cleared, once.
ALTER TABLE "decision_appeals" ADD CONSTRAINT "decision_appeals_grounds"
  CHECK (("grounds" IS NULL) = ("grounds_cleared_at" IS NOT NULL)
     AND ("grounds" IS NULL OR char_length("grounds") BETWEEN 1 AND 2000));
-- The status and the columns that say it, set together. A decision names
-- its manager, the role as named then, and the rationale; the board's
-- overturn (ADR 0059's management_appeal) never decides one.
ALTER TABLE "decision_appeals" ADD CONSTRAINT "decision_appeals_state_shape"
  CHECK ("status" IN ('pending', 'upheld', 'overturned', 'withdrawn')
     AND ("status" IN ('upheld', 'overturned')) = ("decided_at" IS NOT NULL)
     AND ("decided_at" IS NULL) = ("decided_by_account_id" IS NULL)
     AND ("decided_at" IS NULL) = ("decider_role_key" IS NULL)
     AND ("decider_role_name" IS NULL OR "decided_at" IS NOT NULL)
     AND ("decided_at" IS NULL) = ("rationale" IS NULL)
     AND ("rationale" IS NULL OR char_length("rationale") BETWEEN 1 AND 2000)
     AND ("decided_by_account_id" IS NULL OR "decided_by_account_id" IS DISTINCT FROM "decision_by_account_id")
     AND ("status" = 'withdrawn') = ("withdrawn_at" IS NOT NULL)
     AND ("status" = 'pending') = ("effect" IS NULL)
     AND ("effect" IS NULL OR "effect" IN ('applied', 'follow_up', 'none'))
     AND ("effect" IS DISTINCT FROM 'follow_up' OR "status" = 'overturned')
     AND ("effect_reason" IS NULL OR ("effect" IS NOT NULL AND "effect" IN ('follow_up', 'none')))
     AND ("effect_reason" IS NULL OR "effect_reason" IN (
           'window_passed', 'purged', 'requester_gone', 'unit_limit', 'work_rules', 'blocklisted',
           'needs_sticker', 'registrant_gone', 'plate_active', 'permit_date', 'sticker_used', 'changed',
           'needs_review'))
     AND ("followed_up_at" IS NULL OR "effect" IS NOT DISTINCT FROM 'follow_up')
     AND ("followed_up_at" IS NULL) = ("followed_up_by_account_id" IS NULL)
     AND "lodged_at" >= "decision_at"
     AND ("decided_at" IS NULL OR "decided_at" >= "lodged_at")
     AND ("withdrawn_at" IS NULL OR "withdrawn_at" >= "lodged_at"));

-- What was lodged never changes but the grounds' clearing; the status
-- moves from pending once, with what says it; a follow-up once.
CREATE FUNCTION decision_appeal_moves() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."number" = OLD."number" AND NEW."kind" = OLD."kind"
     AND NEW."subject_id" = OLD."subject_id" AND NEW."unit_id" = OLD."unit_id"
     AND NEW."appellant_account_id" = OLD."appellant_account_id"
     AND NEW."decision_at" = OLD."decision_at"
     AND NEW."decision_by_account_id" IS NOT DISTINCT FROM OLD."decision_by_account_id"
     AND NEW."lodged_at" = OLD."lodged_at"
     AND ((NEW."grounds" IS NOT DISTINCT FROM OLD."grounds"
           AND NEW."grounds_cleared_at" IS NOT DISTINCT FROM OLD."grounds_cleared_at")
          OR (OLD."grounds_cleared_at" IS NULL AND NEW."grounds" IS NULL))
     AND (NEW."status" = OLD."status" OR OLD."status" = 'pending')
     AND ((NEW."decided_at" IS NOT DISTINCT FROM OLD."decided_at"
           AND NEW."decided_by_account_id" IS NOT DISTINCT FROM OLD."decided_by_account_id"
           AND NEW."decider_role_key" IS NOT DISTINCT FROM OLD."decider_role_key"
           AND NEW."decider_role_name" IS NOT DISTINCT FROM OLD."decider_role_name"
           AND NEW."rationale" IS NOT DISTINCT FROM OLD."rationale")
          OR OLD."status" = 'pending')
     AND (NEW."withdrawn_at" IS NOT DISTINCT FROM OLD."withdrawn_at" OR OLD."withdrawn_at" IS NULL)
     AND ((NEW."effect" IS NOT DISTINCT FROM OLD."effect"
           AND NEW."effect_reason" IS NOT DISTINCT FROM OLD."effect_reason")
          OR OLD."effect" IS NULL)
     AND ((NEW."followed_up_at" IS NOT DISTINCT FROM OLD."followed_up_at"
           AND NEW."followed_up_by_account_id" IS NOT DISTINCT FROM OLD."followed_up_by_account_id")
          OR OLD."followed_up_at" IS NULL) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'decision_appeals: an appeal is kept as lodged and moves forward once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER decision_appeals_moves
  BEFORE UPDATE OR DELETE ON "decision_appeals"
  FOR EACH ROW EXECUTE FUNCTION decision_appeal_moves();
CREATE TRIGGER decision_appeals_moves_truncate
  BEFORE TRUNCATE ON "decision_appeals"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- An appeal's attachments: written with it, never changed (an erasure
-- marks the files deleted, the rows stay).
CREATE TABLE "decision_appeal_attachments" (
    "tenant_id" UUID NOT NULL,
    "appeal_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "position" SMALLINT NOT NULL,
    CONSTRAINT "decision_appeal_attachments_pkey" PRIMARY KEY ("tenant_id", "appeal_id", "position")
);
CREATE UNIQUE INDEX "decision_appeal_attachments_file_key"
  ON "decision_appeal_attachments"("tenant_id", "file_id");
ALTER TABLE "decision_appeal_attachments"
  ADD CONSTRAINT "decision_appeal_attachments_tenant_id_appeal_id_fkey"
  FOREIGN KEY ("tenant_id", "appeal_id") REFERENCES "decision_appeals"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "decision_appeal_attachments_tenant_id_file_id_fkey"
  FOREIGN KEY ("tenant_id", "file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "decision_appeal_attachments" ADD CONSTRAINT "decision_appeal_attachments_position"
  CHECK ("position" BETWEEN 1 AND 3);
CREATE TRIGGER decision_appeal_attachments_immutable_rows
  BEFORE UPDATE OR DELETE ON "decision_appeal_attachments"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER decision_appeal_attachments_immutable_truncate
  BEFORE TRUNCATE ON "decision_appeal_attachments"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "decision_appeal_counters", "decision_appeals", "decision_appeal_attachments" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "decision_appeal_counters", "decision_appeals" TO jiwar_app;
GRANT SELECT, INSERT ON "decision_appeal_attachments" TO jiwar_app;
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['decision_appeal_counters', 'decision_appeals', 'decision_appeal_attachments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
