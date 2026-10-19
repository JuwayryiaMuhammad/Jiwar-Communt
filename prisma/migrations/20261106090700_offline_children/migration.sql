-- ============================================================================
-- Children's exits offline (ADR 0057; ADR 0054's exit control). Offline, a
-- child leaves alone with leave, or with a household adult whose resident
-- QR the device cannot check and whose ID the guard attests it checked
-- (`idChecked`). Every other escort is refused offline (`offline_unverified`,
-- the household told). At sync:
--
-- - `left_unverified`: released offline, but the server finds the adult's
--   QR forged or stale (`escort_qr_invalid`), the adult no longer the
--   child's escort or not valid then (`not_an_escort`, `escort_inactive`,
--   `outside_validity`, `wrong_post`), or leave to go alone revoked since
--   (`alone_not_allowed`): the household and the keepers alerted.
-- - The action follows the record it made: deleted with it by the 30-day
--   purge (a cascade), its flags with it. Nothing else deletes either.
-- ============================================================================

ALTER TABLE "child_pickups" DROP CONSTRAINT "child_pickups_refusal_shape";
ALTER TABLE "child_pickups" DROP CONSTRAINT "child_pickups_refusal_reason";
ALTER TABLE "child_pickups" DROP CONSTRAINT "child_pickups_method_shape";
ALTER TABLE "child_pickups" DROP CONSTRAINT "child_pickups_escort_shape";
ALTER TABLE "child_pickups"
  -- A refusal has a reason, and so does a release the server could not
  -- verify; nothing else does.
  ADD CONSTRAINT "child_pickups_refusal_shape"
    CHECK (("outcome" IN ('refused', 'alone_refused', 'left_unverified')) = ("refusal_reason" IS NOT NULL)),
  ADD CONSTRAINT "child_pickups_refusal_reason"
    CHECK ("refusal_reason" IS NULL OR "refusal_reason" IN (
      'not_an_escort', 'outside_validity', 'wrong_post', 'escort_inactive',
      'no_credential', 'alone_not_allowed', 'lockdown',
      'escort_qr_invalid', 'offline_unverified')),
  -- Alone means left alone, held, or released alone unverified; an escort
  -- collected the child, was refused, or was released unverified; the
  -- unidentified are refused.
  ADD CONSTRAINT "child_pickups_method_shape"
    CHECK (("outcome" NOT IN ('left_alone', 'alone_refused') OR "method" = 'alone')
           AND ("method" <> 'alone' OR "outcome" IN ('left_alone', 'alone_refused', 'left_unverified'))
           AND ("method" <> 'unidentified' OR "outcome" = 'refused')),
  ADD CONSTRAINT "child_pickups_escort_shape"
    CHECK (("escort_id" IS NULL) = ("escort_kind" IS NULL)
           AND ("outcome" <> 'picked_up' OR "escort_id" IS NOT NULL)
           AND ("escort_id" IS NULL OR "outcome" IN ('picked_up', 'refused', 'left_unverified')));

-- ----------------------------------------------------------------------------
-- The action of an offline exit, and its flags, go with its record.
-- ----------------------------------------------------------------------------
ALTER TABLE "gate_offline_actions" ADD COLUMN "child_pickup_id" UUID;
ALTER TABLE "gate_offline_actions"
  ADD CONSTRAINT "gate_offline_actions_child_pickup_fkey"
    FOREIGN KEY ("tenant_id", "child_pickup_id") REFERENCES "child_pickups"("tenant_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;
CREATE UNIQUE INDEX "gate_offline_actions_child_pickup_key"
  ON "gate_offline_actions"("tenant_id", "child_pickup_id") WHERE "child_pickup_id" IS NOT NULL;

ALTER TABLE "gate_offline_actions" DROP CONSTRAINT "gate_offline_actions_type";
ALTER TABLE "gate_offline_actions" DROP CONSTRAINT "gate_offline_actions_shape";
ALTER TABLE "gate_offline_actions"
  ADD CONSTRAINT "gate_offline_actions_type"
    CHECK ("type" IN ('entry', 'contractor', 'service_vehicle_in', 'service_vehicle_out',
                      'material_entry', 'patrol_scan', 'child_exit')),
  ADD CONSTRAINT "gate_offline_actions_shape"
    CHECK ((("status" = 'recorded')
             = (num_nonnulls("occurred_at", "guard_account_id", "shift_id", "gate_id", "bundle_id") = 5))
       AND (("status" = 'rejected') = ("reject_reason" IS NOT NULL))
       AND ("reject_reason" IS NULL
            OR "reject_reason" IN ('bundle_unknown', 'subject_unknown', 'quarantine_rejected',
                                   'contractor_unresolved', 'patrol_refused'))
       AND (num_nonnulls("entry_id", "service_vehicle_visit_id", "material_entry_id",
                         "patrol_scan_id", "child_pickup_id") <= 1)
       AND ("status" = 'recorded'
            OR num_nonnulls("entry_id", "service_vehicle_visit_id", "material_entry_id",
                            "patrol_scan_id", "child_pickup_id") = 0)
       AND (("status" = 'quarantined') = ("body" IS NOT NULL))
       AND ("body" IS NULL OR jsonb_typeof("body") = 'object')
       AND ("status" <> 'quarantined' OR "reviewed_at" IS NULL)
       AND ("reviewed_at" IS NULL OR "reviewed_at" >= "received_at"));

-- Decided once; deleted only with the child's record it made (the purge's
-- cascade: the app holds no DELETE on actions).
CREATE OR REPLACE FUNCTION gate_offline_action_is_decided_once() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD."type" = 'child_exit' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
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

ALTER TABLE "gate_offline_flags" DROP CONSTRAINT "gate_offline_flags_action_fkey";
ALTER TABLE "gate_offline_flags"
  ADD CONSTRAINT "gate_offline_flags_action_fkey"
    FOREIGN KEY ("tenant_id", "action_id") REFERENCES "gate_offline_actions"("tenant_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "gate_offline_flags" DROP CONSTRAINT "gate_offline_flags_kind";
ALTER TABLE "gate_offline_flags" DROP CONSTRAINT "gate_offline_flags_subject";
ALTER TABLE "gate_offline_flags"
  ADD CONSTRAINT "gate_offline_flags_kind"
    CHECK (("kind", "class") IN (
      ('lockdown_entered', 'security'), ('blocklist_ban_entered', 'security'),
      ('credential_banned', 'security'), ('once_only_reused', 'security'),
      ('action_rejected', 'security'), ('device_revoked_upload', 'security'),
      ('contractor_unresolved', 'security'), ('child_exit_unverified', 'security'),
      ('credential_revoked', 'manager'), ('invalid_at_time', 'manager'),
      ('capacity_exceeded', 'manager'), ('clock_skew', 'manager'),
      ('bundle_expired', 'manager'), ('shift_ended', 'manager'),
      ('patrol_scan_refused', 'manager'),
      ('blocklist_watch_entered', 'info'), ('already_inside', 'info'),
      ('exit_without_entry', 'info'), ('duplicate_inside', 'info'))),
  ADD CONSTRAINT "gate_offline_flags_subject"
    CHECK (("subject_type" IS NULL) = ("subject_id" IS NULL)
       AND ("subject_type" IS NULL
            OR "subject_type" IN ('visitor_pass', 'worker_engagement', 'event_guest', 'move_permit',
                                  'permit_worker', 'service_vehicle', 'material_entry', 'child_control')));

-- A flag goes only with its action's cascade (the child's record purged).
CREATE OR REPLACE FUNCTION gate_offline_flag_moves_forward() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
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
