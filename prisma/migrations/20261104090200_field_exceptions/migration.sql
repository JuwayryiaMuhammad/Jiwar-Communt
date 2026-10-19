-- ============================================================================
-- Field exceptions (ADR 0056). A guard on shift at a gate asks the on-duty
-- management to let in, once, someone the gate refused:
--
-- - `worker_outside_hours`: a domestic worker outside their schedule, or a
--   contractor worker outside the compound's work hours or on a day off;
-- - `visitor_without_pass`: a visitor with no valid pass;
-- - `unregistered_vehicle`: a vehicle the compound does not know.
--
-- Every holder of `gate_exceptions.decide` is told; the first decision
-- wins, under the row's lock, by the database's clock. Nobody answering
-- by `answer_by` (gate_settings.exception_answer_minutes) expires it. An
-- approval lets one entry in at the exception's gate until `entry_until`
-- (gate_settings.exception_entry_minutes): `used_at` is set once, by that
-- entry. It never overrides a lockdown or a ban: both are checked at the
-- request and again at the entry.
--
-- The visitor's name and the vehicle's plate live in `visitor_details`
-- (deleted 30 days after, as every visitor's): nothing here names anyone.
-- Never deleted: entries point at them.
-- ============================================================================

CREATE TABLE "gate_field_exceptions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "reason_code" TEXT NOT NULL,
    "gate_id" UUID NOT NULL,
    "shift_id" UUID NOT NULL,
    "raised_by_account_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "engagement_id" UUID,
    "permit_worker_id" UUID,
    "visitor_details_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "raised_at" TIMESTAMPTZ(3) NOT NULL,
    "answer_by" TIMESTAMPTZ(3) NOT NULL,
    "decided_at" TIMESTAMPTZ(3),
    "decided_by_account_id" UUID,
    "reject_reason_code" TEXT,
    "entry_until" TIMESTAMPTZ(3),
    "used_at" TIMESTAMPTZ(3),
    "used_entry_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "gate_field_exceptions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "gate_field_exceptions_tenant_id_id_key"
  ON "gate_field_exceptions"("tenant_id", "id");
CREATE UNIQUE INDEX "gate_field_exceptions_number_key"
  ON "gate_field_exceptions"("tenant_id", "number");
-- One entry per approval, ever.
CREATE UNIQUE INDEX "gate_field_exceptions_used_entry_key"
  ON "gate_field_exceptions"("tenant_id", "used_entry_id");
-- The deciders' inbox, and the sweep's due ones.
CREATE INDEX "gate_field_exceptions_pending_idx"
  ON "gate_field_exceptions"("tenant_id", "answer_by") WHERE "status" = 'pending';
CREATE INDEX "gate_field_exceptions_list_idx"
  ON "gate_field_exceptions"("tenant_id", "raised_at" DESC, "id" DESC);
CREATE INDEX "gate_field_exceptions_shift_idx"
  ON "gate_field_exceptions"("tenant_id", "shift_id");

ALTER TABLE "gate_field_exceptions"
  ADD CONSTRAINT "gate_field_exceptions_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_field_exceptions_tenant_id_gate_id_fkey"
    FOREIGN KEY ("tenant_id", "gate_id") REFERENCES "gates"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_field_exceptions_tenant_id_shift_id_fkey"
    FOREIGN KEY ("tenant_id", "shift_id") REFERENCES "guard_shifts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_field_exceptions_tenant_id_raised_by_fkey"
    FOREIGN KEY ("tenant_id", "raised_by_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_field_exceptions_tenant_id_decided_by_fkey"
    FOREIGN KEY ("tenant_id", "decided_by_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_field_exceptions_tenant_id_unit_id_fkey"
    FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_field_exceptions_tenant_id_engagement_id_fkey"
    FOREIGN KEY ("tenant_id", "engagement_id") REFERENCES "worker_engagements"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_field_exceptions_tenant_id_permit_worker_id_fkey"
    FOREIGN KEY ("tenant_id", "permit_worker_id") REFERENCES "permit_workers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_field_exceptions_tenant_id_visitor_details_id_fkey"
    FOREIGN KEY ("tenant_id", "visitor_details_id") REFERENCES "visitor_details"("tenant_id", "id")
    ON DELETE SET NULL ("visitor_details_id") ON UPDATE RESTRICT;

ALTER TABLE "gate_field_exceptions"
  ADD CONSTRAINT "gate_field_exceptions_number_positive" CHECK ("number" > 0),
  ADD CONSTRAINT "gate_field_exceptions_kind"
    CHECK ("kind" IN ('worker_outside_hours', 'visitor_without_pass', 'unregistered_vehicle')),
  -- REASON_CODES.gateExceptionRaise.
  ADD CONSTRAINT "gate_field_exceptions_reason"
    CHECK ("reason_code" IN ('resident_unreachable', 'expected_by_resident', 'regular_visitor',
                             'urgent_service', 'delivery_waiting', 'emergency', 'other')),
  -- A worker's is about exactly one worker; a visitor's and a vehicle's
  -- about none (their details hold the name and the plate).
  ADD CONSTRAINT "gate_field_exceptions_worker_shape"
    CHECK (("kind" = 'worker_outside_hours') = (num_nonnulls("engagement_id", "permit_worker_id") = 1)
       AND num_nonnulls("engagement_id", "permit_worker_id") <= 1
       AND ("kind" <> 'worker_outside_hours' OR "visitor_details_id" IS NULL)),
  ADD CONSTRAINT "gate_field_exceptions_status"
    CHECK ("status" IN ('pending', 'approved', 'rejected', 'expired', 'withdrawn')),
  ADD CONSTRAINT "gate_field_exceptions_answer_window"
    CHECK ("answer_by" > "raised_at"),
  -- Decided means when; a person decides an approval or a rejection, the
  -- system an expiry, the guard a withdrawal.
  ADD CONSTRAINT "gate_field_exceptions_decision_shape"
    CHECK (("status" = 'pending') = ("decided_at" IS NULL)
       AND ("decided_at" IS NULL OR "decided_at" >= "raised_at")
       AND (("status" IN ('approved', 'rejected')) = ("decided_by_account_id" IS NOT NULL))
       AND (("status" = 'rejected') = ("reject_reason_code" IS NOT NULL))
       AND (("status" = 'approved') = ("entry_until" IS NOT NULL))
       AND ("entry_until" IS NULL
            OR ("decided_at" IS NOT NULL AND "entry_until" > "decided_at"))),
  -- REASON_CODES.gateExceptionReject.
  ADD CONSTRAINT "gate_field_exceptions_reject_reason"
    CHECK ("reject_reason_code" IS NULL
        OR "reject_reason_code" IN ('not_expected', 'identity_unclear', 'outside_policy', 'other')),
  -- Used once, by an entry within the approval's window.
  ADD CONSTRAINT "gate_field_exceptions_used_shape"
    CHECK (("used_at" IS NULL) = ("used_entry_id" IS NULL)
       AND ("used_at" IS NULL
            OR ("status" = 'approved' AND "decided_at" IS NOT NULL AND "entry_until" IS NOT NULL
                AND "used_at" >= "decided_at" AND "used_at" <= "entry_until")));

-- What was asked never changes; the status moves once from pending; the
-- use is set once on an approval. Never deleted.
CREATE FUNCTION gate_field_exception_moves_forward() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."number" = OLD."number"
     AND NEW."kind" = OLD."kind"
     AND NEW."reason_code" = OLD."reason_code"
     AND NEW."gate_id" = OLD."gate_id"
     AND NEW."shift_id" = OLD."shift_id"
     AND NEW."raised_by_account_id" = OLD."raised_by_account_id"
     AND NEW."unit_id" = OLD."unit_id"
     AND NEW."engagement_id" IS NOT DISTINCT FROM OLD."engagement_id"
     AND NEW."permit_worker_id" IS NOT DISTINCT FROM OLD."permit_worker_id"
     -- The details go when they expire (ON DELETE SET NULL), never back.
     AND (NEW."visitor_details_id" IS NOT DISTINCT FROM OLD."visitor_details_id"
          OR NEW."visitor_details_id" IS NULL)
     AND NEW."raised_at" = OLD."raised_at"
     AND NEW."answer_by" = OLD."answer_by"
     AND NEW."created_at" = OLD."created_at"
     -- Decided once.
     AND (OLD."status" = 'pending'
          OR (NEW."status" = OLD."status"
              AND NEW."decided_at" = OLD."decided_at"
              AND NEW."decided_by_account_id" IS NOT DISTINCT FROM OLD."decided_by_account_id"
              AND NEW."reject_reason_code" IS NOT DISTINCT FROM OLD."reject_reason_code"
              AND NEW."entry_until" IS NOT DISTINCT FROM OLD."entry_until"))
     -- Used once.
     AND (OLD."used_at" IS NULL
          OR (NEW."used_at" = OLD."used_at" AND NEW."used_entry_id" = OLD."used_entry_id")) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'gate_field_exceptions: what was asked never changes, it is decided and used once, and never deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER gate_field_exceptions_move_forward
  BEFORE UPDATE OR DELETE ON "gate_field_exceptions"
  FOR EACH ROW EXECUTE FUNCTION gate_field_exception_moves_forward();
CREATE TRIGGER gate_field_exceptions_move_forward_truncate
  BEFORE TRUNCATE ON "gate_field_exceptions"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "gate_field_exceptions" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "gate_field_exceptions" TO jiwar_app;
ALTER TABLE "gate_field_exceptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "gate_field_exceptions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "gate_field_exceptions"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ----------------------------------------------------------------------------
-- The gate log: an entry on an exception. A visitor or a vehicle comes in
-- as the exception itself (subject `field_exception`); a worker stays the
-- worker, and the entry names the exception that waived their hours. Like
-- `approval_request_id`, no key: the log outlives what it names.
-- ----------------------------------------------------------------------------
ALTER TABLE "gate_entries" ADD COLUMN "field_exception_id" UUID;
ALTER TABLE "gate_entries" DROP CONSTRAINT "gate_entries_method_matches_direction";
ALTER TABLE "gate_entries" ADD CONSTRAINT "gate_entries_method_matches_direction"
  CHECK (("direction" = 'in') = ("method" IN ('code', 'qr', 'approval', 'permit', 'exception')));
ALTER TABLE "gate_entries" ADD CONSTRAINT "gate_entries_exception_shape"
  CHECK (("method" = 'exception') = ("field_exception_id" IS NOT NULL)
     AND ("subject_type" <> 'field_exception' OR "direction" = 'out' OR "method" = 'exception'));

-- ----------------------------------------------------------------------------
-- The blocklist meets an exception's visitor or vehicle where it meets a
-- gate request's: at the request, and at the entry.
-- ----------------------------------------------------------------------------
ALTER TABLE "blocklist_matches" DROP CONSTRAINT "blocklist_matches_source";
ALTER TABLE "blocklist_matches" ADD CONSTRAINT "blocklist_matches_source"
  CHECK ("source" IN ('visitor_pass', 'move_permit', 'event_guest', 'gate_request', 'verify', 'entry',
                      'plate_lookup', 'id_lookup', 'field_exception'));
ALTER TABLE "blocklist_matches" DROP CONSTRAINT "blocklist_matches_subject";
ALTER TABLE "blocklist_matches" ADD CONSTRAINT "blocklist_matches_subject"
  CHECK (("subject_type" IS NULL) = ("subject_id" IS NULL)
     AND ("subject_type" IS NULL
          OR "subject_type" IN ('visitor_pass', 'gate_request', 'event_guest', 'move_permit', 'field_exception')));
