-- ============================================================================
-- Offline uploads (ADR 0057). A guard device sends what it recorded while
-- offline in signed batches; each action carries the app's own id, the
-- device's sequence number, its calibrated time and the bundle it was
-- decided with. What physically happened is recorded at its device time
-- (clamped) and flagged where the server knows more; what cannot have
-- happened (an unknown bundle or subject) is rejected and flagged.
--
-- - `gate_offline_batches`: one per batch the server took, never its
--   payload: its SHA-256, the device's clock offset, how many actions.
-- - `gate_offline_actions`: one per action, its id the app's; what it
--   recorded (an entry: a pointer, as gate entries are kept forever and
--   name nothing by key); never a code, a plate, a name or an ID.
-- - `gate_offline_flags`: what the server knew that the device did not —
--   codes and numbers only — told per batch to the management, cleared
--   (an exit whose entry came later) or reviewed once.
--
-- The device's `acked_seq` is the last of its actions received without a
-- gap; `max_seq` the highest received. Both only grow.
-- ============================================================================

ALTER TABLE "gate_devices"
  ADD COLUMN "acked_seq" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "max_seq" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "rejection_alerted_at" TIMESTAMPTZ(3);
ALTER TABLE "gate_devices"
  ADD CONSTRAINT "gate_devices_seq_shape"
    CHECK ("acked_seq" >= 0 AND "max_seq" >= "acked_seq");

CREATE OR REPLACE FUNCTION gate_device_is_kept() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."public_key" = OLD."public_key"
     AND NEW."label" IS NOT DISTINCT FROM OLD."label"
     AND NEW."enrolled_by_account_id" = OLD."enrolled_by_account_id"
     AND NEW."enrolled_at" = OLD."enrolled_at"
     AND NEW."created_at" = OLD."created_at"
     AND (OLD."revoked_at" IS NULL
          OR (NEW."revoked_at" = OLD."revoked_at"
              AND NEW."revoked_by_account_id" = OLD."revoked_by_account_id"
              AND NEW."revoke_reason" = OLD."revoke_reason"))
     AND NEW."bundle_version" >= OLD."bundle_version"
     AND (OLD."last_bundle_at" IS NULL OR NEW."last_bundle_at" >= OLD."last_bundle_at")
     AND NEW."acked_seq" >= OLD."acked_seq"
     AND NEW."max_seq" >= OLD."max_seq" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'gate_devices: a device keeps its key and is revoked once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

-- ----------------------------------------------------------------------------
-- Batches
-- ----------------------------------------------------------------------------
CREATE TABLE "gate_offline_batches" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "uploaded_by_account_id" UUID NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL,
    "sent_at" TIMESTAMPTZ(3) NOT NULL,
    "clock_offset_ms" INTEGER NOT NULL,
    "payload_sha256" CHAR(64) NOT NULL,
    "action_count" SMALLINT NOT NULL,
    "status" TEXT NOT NULL,
    CONSTRAINT "gate_offline_batches_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "gate_offline_batches_tenant_id_id_key"
  ON "gate_offline_batches"("tenant_id", "id");
CREATE INDEX "gate_offline_batches_device_idx"
  ON "gate_offline_batches"("tenant_id", "device_id", "received_at" DESC);

ALTER TABLE "gate_offline_batches"
  ADD CONSTRAINT "gate_offline_batches_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_offline_batches_device_fkey"
    FOREIGN KEY ("tenant_id", "device_id") REFERENCES "gate_devices"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_offline_batches_uploaded_by_fkey"
    FOREIGN KEY ("tenant_id", "uploaded_by_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "gate_offline_batches"
  ADD CONSTRAINT "gate_offline_batches_sha256"
    CHECK ("payload_sha256" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "gate_offline_batches_action_count"
    CHECK ("action_count" BETWEEN 1 AND 100),
  ADD CONSTRAINT "gate_offline_batches_status"
    CHECK ("status" IN ('accepted'));

CREATE TRIGGER gate_offline_batches_immutable_rows
  BEFORE UPDATE OR DELETE ON "gate_offline_batches"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER gate_offline_batches_immutable_truncate
  BEFORE TRUNCATE ON "gate_offline_batches"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "gate_offline_batches" FROM jiwar_app;
GRANT SELECT, INSERT ON "gate_offline_batches" TO jiwar_app;
ALTER TABLE "gate_offline_batches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "gate_offline_batches" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "gate_offline_batches"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ----------------------------------------------------------------------------
-- Actions
-- ----------------------------------------------------------------------------
CREATE TABLE "gate_offline_actions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "content_sha256" CHAR(64) NOT NULL,
    "bundle_id" UUID,
    "device_time" TIMESTAMPTZ(3) NOT NULL,
    "occurred_at" TIMESTAMPTZ(3),
    "received_at" TIMESTAMPTZ(3) NOT NULL,
    "status" TEXT NOT NULL,
    "reject_reason" TEXT,
    "guard_account_id" UUID,
    "shift_id" UUID,
    "gate_id" UUID,
    -- The entry it recorded: a pointer, as gate entries name nothing by key.
    "entry_id" UUID,
    CONSTRAINT "gate_offline_actions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "gate_offline_actions_tenant_id_id_key"
  ON "gate_offline_actions"("tenant_id", "id");
-- A device's sequence number names one action, ever.
CREATE UNIQUE INDEX "gate_offline_actions_seq_key"
  ON "gate_offline_actions"("tenant_id", "device_id", "seq");
CREATE UNIQUE INDEX "gate_offline_actions_entry_key"
  ON "gate_offline_actions"("tenant_id", "entry_id") WHERE "entry_id" IS NOT NULL;
CREATE INDEX "gate_offline_actions_batch_idx"
  ON "gate_offline_actions"("tenant_id", "batch_id", "seq");

ALTER TABLE "gate_offline_actions"
  ADD CONSTRAINT "gate_offline_actions_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_offline_actions_device_fkey"
    FOREIGN KEY ("tenant_id", "device_id") REFERENCES "gate_devices"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_offline_actions_batch_fkey"
    FOREIGN KEY ("tenant_id", "batch_id") REFERENCES "gate_offline_batches"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_offline_actions_bundle_fkey"
    FOREIGN KEY ("tenant_id", "bundle_id") REFERENCES "gate_offline_bundles"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_offline_actions_guard_fkey"
    FOREIGN KEY ("tenant_id", "guard_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_offline_actions_shift_fkey"
    FOREIGN KEY ("tenant_id", "shift_id") REFERENCES "guard_shifts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_offline_actions_gate_fkey"
    FOREIGN KEY ("tenant_id", "gate_id") REFERENCES "gates"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "gate_offline_actions"
  ADD CONSTRAINT "gate_offline_actions_seq_positive" CHECK ("seq" > 0),
  ADD CONSTRAINT "gate_offline_actions_type" CHECK ("type" IN ('entry')),
  ADD CONSTRAINT "gate_offline_actions_sha256"
    CHECK ("content_sha256" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "gate_offline_actions_status"
    CHECK ("status" IN ('recorded', 'rejected')),
  -- Recorded: when, by whom, at which gate and shift, from which bundle.
  -- Rejected: why, from its closed list (offline-rules.ts REJECTIONS).
  ADD CONSTRAINT "gate_offline_actions_shape"
    CHECK ((("status" = 'recorded')
             = (num_nonnulls("occurred_at", "guard_account_id", "shift_id", "gate_id", "bundle_id") = 5))
       AND (("status" = 'rejected') = ("reject_reason" IS NOT NULL))
       AND ("reject_reason" IS NULL
            OR "reject_reason" IN ('bundle_unknown', 'subject_unknown'))
       AND ("entry_id" IS NULL OR "status" = 'recorded'));

CREATE TRIGGER gate_offline_actions_immutable_rows
  BEFORE UPDATE OR DELETE ON "gate_offline_actions"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER gate_offline_actions_immutable_truncate
  BEFORE TRUNCATE ON "gate_offline_actions"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "gate_offline_actions" FROM jiwar_app;
GRANT SELECT, INSERT ON "gate_offline_actions" TO jiwar_app;
ALTER TABLE "gate_offline_actions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "gate_offline_actions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "gate_offline_actions"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ----------------------------------------------------------------------------
-- Flags
-- ----------------------------------------------------------------------------
CREATE TABLE "gate_offline_flags" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "action_id" UUID,
    "device_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "class" TEXT NOT NULL,
    "subject_type" TEXT,
    "subject_id" UUID,
    "gate_id" UUID,
    "shift_id" UUID,
    "params" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "alerted_at" TIMESTAMPTZ(3),
    "cleared_at" TIMESTAMPTZ(3),
    "cleared_reason" TEXT,
    "reviewed_at" TIMESTAMPTZ(3),
    "reviewed_by_account_id" UUID,
    "review_code" TEXT,
    CONSTRAINT "gate_offline_flags_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "gate_offline_flags_tenant_id_id_key"
  ON "gate_offline_flags"("tenant_id", "id");
-- The management's list, newest first; what waits to be told.
CREATE INDEX "gate_offline_flags_list_idx"
  ON "gate_offline_flags"("tenant_id", "created_at" DESC, "id" DESC);
CREATE INDEX "gate_offline_flags_unalerted_idx"
  ON "gate_offline_flags"("tenant_id", "created_at") WHERE "alerted_at" IS NULL AND "class" <> 'info';
-- An exit without its entry, open: cleared when the entry arrives.
CREATE INDEX "gate_offline_flags_open_exit_idx"
  ON "gate_offline_flags"("tenant_id", "subject_type", "subject_id")
  WHERE "kind" = 'exit_without_entry' AND "cleared_at" IS NULL;
CREATE INDEX "gate_offline_flags_batch_idx"
  ON "gate_offline_flags"("tenant_id", "batch_id");

ALTER TABLE "gate_offline_flags"
  ADD CONSTRAINT "gate_offline_flags_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_offline_flags_batch_fkey"
    FOREIGN KEY ("tenant_id", "batch_id") REFERENCES "gate_offline_batches"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_offline_flags_action_fkey"
    FOREIGN KEY ("tenant_id", "action_id") REFERENCES "gate_offline_actions"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_offline_flags_device_fkey"
    FOREIGN KEY ("tenant_id", "device_id") REFERENCES "gate_devices"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_offline_flags_gate_fkey"
    FOREIGN KEY ("tenant_id", "gate_id") REFERENCES "gates"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_offline_flags_shift_fkey"
    FOREIGN KEY ("tenant_id", "shift_id") REFERENCES "guard_shifts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_offline_flags_reviewed_by_fkey"
    FOREIGN KEY ("tenant_id", "reviewed_by_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "gate_offline_flags"
  -- offline-rules.ts FLAG_KINDS, each with its class (FLAG_CLASS).
  ADD CONSTRAINT "gate_offline_flags_kind"
    CHECK (("kind", "class") IN (
      ('lockdown_entered', 'security'), ('blocklist_ban_entered', 'security'),
      ('credential_banned', 'security'), ('once_only_reused', 'security'),
      ('action_rejected', 'security'),
      ('credential_revoked', 'manager'), ('invalid_at_time', 'manager'),
      ('capacity_exceeded', 'manager'), ('clock_skew', 'manager'),
      ('bundle_expired', 'manager'), ('shift_ended', 'manager'),
      ('blocklist_watch_entered', 'info'), ('already_inside', 'info'),
      ('exit_without_entry', 'info'))),
  ADD CONSTRAINT "gate_offline_flags_subject"
    CHECK (("subject_type" IS NULL) = ("subject_id" IS NULL)
       AND ("subject_type" IS NULL
            OR "subject_type" IN ('visitor_pass', 'worker_engagement'))),
  -- Codes and numbers only, never words.
  ADD CONSTRAINT "gate_offline_flags_params"
    CHECK (jsonb_typeof("params") = 'object'),
  -- Cleared only by an entry that came later, and only an exit's flag.
  ADD CONSTRAINT "gate_offline_flags_cleared"
    CHECK ((("cleared_at" IS NULL) = ("cleared_reason" IS NULL))
       AND ("cleared_reason" IS NULL
            OR ("cleared_reason" = 'reconciled' AND "kind" = 'exit_without_entry'))),
  -- Reviewed: when, by whom, with a code (REASON_CODES.offlineFlagReview).
  ADD CONSTRAINT "gate_offline_flags_review_shape"
    CHECK (num_nonnulls("reviewed_at", "reviewed_by_account_id", "review_code") IN (0, 3)
       AND ("review_code" IS NULL
            OR "review_code" IN ('confirmed', 'followed_up', 'false_alarm', 'other')));

-- What was flagged never changes; it is told, cleared and reviewed once
-- each. Never deleted.
CREATE FUNCTION gate_offline_flag_moves_forward() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."batch_id" = OLD."batch_id"
     AND NEW."action_id" IS NOT DISTINCT FROM OLD."action_id"
     AND NEW."device_id" = OLD."device_id"
     AND NEW."kind" = OLD."kind"
     AND NEW."class" = OLD."class"
     AND NEW."subject_type" IS NOT DISTINCT FROM OLD."subject_type"
     AND NEW."subject_id" IS NOT DISTINCT FROM OLD."subject_id"
     AND NEW."gate_id" IS NOT DISTINCT FROM OLD."gate_id"
     AND NEW."shift_id" IS NOT DISTINCT FROM OLD."shift_id"
     AND NEW."params" = OLD."params"
     AND NEW."created_at" = OLD."created_at"
     AND (OLD."alerted_at" IS NULL OR NEW."alerted_at" = OLD."alerted_at")
     AND (OLD."cleared_at" IS NULL
          OR (NEW."cleared_at" = OLD."cleared_at" AND NEW."cleared_reason" = OLD."cleared_reason"))
     AND (OLD."reviewed_at" IS NULL
          OR (NEW."reviewed_at" = OLD."reviewed_at"
              AND NEW."reviewed_by_account_id" = OLD."reviewed_by_account_id"
              AND NEW."review_code" = OLD."review_code")) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'gate_offline_flags: a flag is told, cleared and reviewed once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER gate_offline_flags_moves_forward
  BEFORE UPDATE OR DELETE ON "gate_offline_flags"
  FOR EACH ROW EXECUTE FUNCTION gate_offline_flag_moves_forward();
CREATE TRIGGER gate_offline_flags_moves_forward_truncate
  BEFORE TRUNCATE ON "gate_offline_flags"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "gate_offline_flags" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "gate_offline_flags" TO jiwar_app;
ALTER TABLE "gate_offline_flags" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "gate_offline_flags" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "gate_offline_flags"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ----------------------------------------------------------------------------
-- The blocklist meets a plate an offline entry let in, at sync.
-- ----------------------------------------------------------------------------
ALTER TABLE "blocklist_matches" DROP CONSTRAINT "blocklist_matches_source";
ALTER TABLE "blocklist_matches" ADD CONSTRAINT "blocklist_matches_source"
  CHECK ("source" IN ('visitor_pass', 'move_permit', 'event_guest', 'gate_request', 'verify', 'entry',
                      'plate_lookup', 'id_lookup', 'field_exception', 'service_vehicle',
                      'offline_sync'));
