-- ============================================================================
-- More of the gate works offline (ADR 0057): event guests and move trucks
-- by plate or list, contractors by their permit and the last four of their
-- ID (matched at sync, never kept), service vehicles in and out by plate,
-- material entries, and the scans of a patrol started online. Each action
-- names what it recorded; a contractor no worker matches, or a scan the
-- run refuses, is rejected with its reason and flagged.
-- ============================================================================

-- What an action recorded, besides an entry.
CREATE UNIQUE INDEX "material_entries_tenant_id_id_key"
  ON "material_entries"("tenant_id", "id");

ALTER TABLE "gate_offline_actions"
  ADD COLUMN "service_vehicle_visit_id" UUID,
  ADD COLUMN "material_entry_id" UUID,
  ADD COLUMN "patrol_scan_id" UUID;
ALTER TABLE "gate_offline_actions"
  ADD CONSTRAINT "gate_offline_actions_service_vehicle_fkey"
    FOREIGN KEY ("tenant_id", "service_vehicle_visit_id") REFERENCES "service_vehicle_visits"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_offline_actions_material_entry_fkey"
    FOREIGN KEY ("tenant_id", "material_entry_id") REFERENCES "material_entries"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_offline_actions_patrol_scan_fkey"
    FOREIGN KEY ("tenant_id", "patrol_scan_id") REFERENCES "patrol_scans"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE UNIQUE INDEX "gate_offline_actions_material_entry_key"
  ON "gate_offline_actions"("tenant_id", "material_entry_id") WHERE "material_entry_id" IS NOT NULL;
CREATE UNIQUE INDEX "gate_offline_actions_patrol_scan_key"
  ON "gate_offline_actions"("tenant_id", "patrol_scan_id") WHERE "patrol_scan_id" IS NOT NULL;

ALTER TABLE "gate_offline_actions" DROP CONSTRAINT "gate_offline_actions_type";
ALTER TABLE "gate_offline_actions" DROP CONSTRAINT "gate_offline_actions_shape";
ALTER TABLE "gate_offline_actions"
  ADD CONSTRAINT "gate_offline_actions_type"
    CHECK ("type" IN ('entry', 'contractor', 'service_vehicle_in', 'service_vehicle_out',
                      'material_entry', 'patrol_scan')),
  ADD CONSTRAINT "gate_offline_actions_shape"
    CHECK ((("status" = 'recorded')
             = (num_nonnulls("occurred_at", "guard_account_id", "shift_id", "gate_id", "bundle_id") = 5))
       AND (("status" = 'rejected') = ("reject_reason" IS NOT NULL))
       AND ("reject_reason" IS NULL
            OR "reject_reason" IN ('bundle_unknown', 'subject_unknown', 'quarantine_rejected',
                                   'contractor_unresolved', 'patrol_refused'))
       AND (num_nonnulls("entry_id", "service_vehicle_visit_id", "material_entry_id", "patrol_scan_id") <= 1)
       AND ("status" = 'recorded'
            OR num_nonnulls("entry_id", "service_vehicle_visit_id", "material_entry_id", "patrol_scan_id") = 0)
       AND (("status" = 'quarantined') = ("body" IS NOT NULL))
       AND ("body" IS NULL OR jsonb_typeof("body") = 'object')
       AND ("status" <> 'quarantined' OR "reviewed_at" IS NULL)
       AND ("reviewed_at" IS NULL OR "reviewed_at" >= "received_at"));

ALTER TABLE "gate_offline_flags" DROP CONSTRAINT "gate_offline_flags_kind";
ALTER TABLE "gate_offline_flags" DROP CONSTRAINT "gate_offline_flags_subject";
ALTER TABLE "gate_offline_flags"
  ADD CONSTRAINT "gate_offline_flags_kind"
    CHECK (("kind", "class") IN (
      ('lockdown_entered', 'security'), ('blocklist_ban_entered', 'security'),
      ('credential_banned', 'security'), ('once_only_reused', 'security'),
      ('action_rejected', 'security'), ('device_revoked_upload', 'security'),
      ('contractor_unresolved', 'security'),
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
                                  'permit_worker', 'service_vehicle', 'material_entry')));
