-- ============================================================================
-- A revoked device's uploads are quarantined, never discarded (ADR 0057).
-- Its actions are kept as sent (less anything secret, in `body`), nothing
-- is recorded, and one security flag goes on the batch. The management
-- decides the batch once: accepted, each action is decided as it would
-- have been at its receipt (recorded at its device time, flagged, or
-- rejected); rejected, each is kept, rejected (`quarantine_rejected`).
-- Either way `body` goes and `reviewed_at` says when.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Batches: quarantined at receipt, reviewed once.
-- ----------------------------------------------------------------------------
ALTER TABLE "gate_offline_batches"
  ADD COLUMN "reviewed_at" TIMESTAMPTZ(3),
  ADD COLUMN "reviewed_by_account_id" UUID,
  ADD COLUMN "review_decision" TEXT;
ALTER TABLE "gate_offline_batches"
  ADD CONSTRAINT "gate_offline_batches_reviewed_by_fkey"
    FOREIGN KEY ("tenant_id", "reviewed_by_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "gate_offline_batches" DROP CONSTRAINT "gate_offline_batches_status";
ALTER TABLE "gate_offline_batches"
  ADD CONSTRAINT "gate_offline_batches_status"
    CHECK ("status" IN ('accepted', 'quarantined')),
  ADD CONSTRAINT "gate_offline_batches_review_shape"
    CHECK (num_nonnulls("reviewed_at", "reviewed_by_account_id", "review_decision") IN (0, 3)
       AND ("review_decision" IS NULL OR "review_decision" IN ('accepted', 'rejected'))
       AND ("reviewed_at" IS NULL OR "reviewed_at" >= "received_at"));

DROP TRIGGER "gate_offline_batches_immutable_rows" ON "gate_offline_batches";
-- What arrived never changes; a batch is reviewed once. Never deleted.
CREATE FUNCTION gate_offline_batch_is_reviewed_once() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."device_id" = OLD."device_id"
     AND NEW."uploaded_by_account_id" = OLD."uploaded_by_account_id"
     AND NEW."received_at" = OLD."received_at"
     AND NEW."sent_at" = OLD."sent_at"
     AND NEW."clock_offset_ms" = OLD."clock_offset_ms"
     AND NEW."payload_sha256" = OLD."payload_sha256"
     AND NEW."action_count" = OLD."action_count"
     AND NEW."status" = OLD."status"
     AND OLD."reviewed_at" IS NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'gate_offline_batches: a batch is kept as it arrived and reviewed once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER gate_offline_batches_reviewed_once
  BEFORE UPDATE OR DELETE ON "gate_offline_batches"
  FOR EACH ROW EXECUTE FUNCTION gate_offline_batch_is_reviewed_once();
GRANT UPDATE ON "gate_offline_batches" TO jiwar_app;

-- ----------------------------------------------------------------------------
-- Actions: quarantined, then recorded or rejected once.
-- ----------------------------------------------------------------------------
ALTER TABLE "gate_offline_actions"
  ADD COLUMN "body" JSONB,
  ADD COLUMN "reviewed_at" TIMESTAMPTZ(3);
ALTER TABLE "gate_offline_actions" DROP CONSTRAINT "gate_offline_actions_status";
ALTER TABLE "gate_offline_actions" DROP CONSTRAINT "gate_offline_actions_shape";
ALTER TABLE "gate_offline_actions"
  ADD CONSTRAINT "gate_offline_actions_status"
    CHECK ("status" IN ('recorded', 'rejected', 'quarantined')),
  -- Recorded: when, by whom, at which gate and shift, from which bundle.
  -- Rejected: why, from its closed list (offline-rules.ts REJECTIONS).
  -- Quarantined: what it said, nothing recorded, not reviewed yet.
  ADD CONSTRAINT "gate_offline_actions_shape"
    CHECK ((("status" = 'recorded')
             = (num_nonnulls("occurred_at", "guard_account_id", "shift_id", "gate_id", "bundle_id") = 5))
       AND (("status" = 'rejected') = ("reject_reason" IS NOT NULL))
       AND ("reject_reason" IS NULL
            OR "reject_reason" IN ('bundle_unknown', 'subject_unknown', 'quarantine_rejected'))
       AND ("entry_id" IS NULL OR "status" = 'recorded')
       AND (("status" = 'quarantined') = ("body" IS NOT NULL))
       AND ("body" IS NULL OR jsonb_typeof("body") = 'object')
       AND ("status" <> 'quarantined' OR "reviewed_at" IS NULL)
       AND ("reviewed_at" IS NULL OR "reviewed_at" >= "received_at"));

DROP TRIGGER "gate_offline_actions_immutable_rows" ON "gate_offline_actions";
-- What arrived never changes; a quarantined action is decided once, and
-- its body goes. Never deleted.
CREATE FUNCTION gate_offline_action_is_decided_once() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."device_id" = OLD."device_id"
     AND NEW."batch_id" = OLD."batch_id"
     AND NEW."seq" = OLD."seq"
     AND NEW."type" = OLD."type"
     AND NEW."content_sha256" = OLD."content_sha256"
     AND NEW."device_time" = OLD."device_time"
     AND NEW."received_at" = OLD."received_at"
     AND OLD."status" = 'quarantined'
     AND NEW."status" IN ('recorded', 'rejected')
     AND NEW."body" IS NULL
     AND NEW."reviewed_at" IS NOT NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'gate_offline_actions: an action is kept as it arrived and decided once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER gate_offline_actions_decided_once
  BEFORE UPDATE OR DELETE ON "gate_offline_actions"
  FOR EACH ROW EXECUTE FUNCTION gate_offline_action_is_decided_once();
GRANT UPDATE ON "gate_offline_actions" TO jiwar_app;
-- The management's queue: batches holding quarantined actions.
CREATE INDEX "gate_offline_actions_quarantined_idx"
  ON "gate_offline_actions"("tenant_id", "batch_id") WHERE "status" = 'quarantined';

-- ----------------------------------------------------------------------------
-- The quarantine's flag, once per batch.
-- ----------------------------------------------------------------------------
ALTER TABLE "gate_offline_flags" DROP CONSTRAINT "gate_offline_flags_kind";
ALTER TABLE "gate_offline_flags"
  ADD CONSTRAINT "gate_offline_flags_kind"
    CHECK (("kind", "class") IN (
      ('lockdown_entered', 'security'), ('blocklist_ban_entered', 'security'),
      ('credential_banned', 'security'), ('once_only_reused', 'security'),
      ('action_rejected', 'security'), ('device_revoked_upload', 'security'),
      ('credential_revoked', 'manager'), ('invalid_at_time', 'manager'),
      ('capacity_exceeded', 'manager'), ('clock_skew', 'manager'),
      ('bundle_expired', 'manager'), ('shift_ended', 'manager'),
      ('blocklist_watch_entered', 'info'), ('already_inside', 'info'),
      ('exit_without_entry', 'info')));
CREATE UNIQUE INDEX "gate_offline_flags_quarantine_key"
  ON "gate_offline_flags"("tenant_id", "batch_id") WHERE "kind" = 'device_revoked_upload';
