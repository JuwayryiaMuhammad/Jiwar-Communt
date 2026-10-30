-- ============================================================================
-- G8 (ADR 0068): face checks at the gate. Advisory only: a guard's photo of
-- someone at the gate is searched against the faces of the blocklist's live
-- entries (1:N), through the compound's face vendor; a possible match is
-- the guard's to judge and the keepers' to hear of, never a refusal by
-- itself. A compound turns it on (`gate_settings.face_checks`), off by
-- default, having posted a visible notice at the gate: a face template is
-- sensitive data (Egypt's Law 151/2020).
--
-- `gate_face_enrollments` is the vendor's gallery as an outbox, one row per
-- template an entry has or had: pending (to enrol), enrolled (the vendor
-- holds its template), removing (to remove), removed. A sweep makes the
-- vendor calls between two transactions, on a lease, so an enrolment never
-- has two calls in flight: a lift while it enrols leaves `removing`, and
-- the template it returns is removed next. One live (pending or enrolled)
-- per entry; a replaced photo starts a new one while the old is removed.
--
-- `gate_face_checks` is each check a guard made: the probe photo, then the
-- outcome once the vendor answered. The probe goes after a day, or 30 days
-- after a possible match (as a visitor's photo). The vendor's score is
-- never kept.
-- ============================================================================

ALTER TABLE "gate_settings" ADD COLUMN "face_checks" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "gate_face_enrollments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "entry_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "template_ref" TEXT,
    "attempts" SMALLINT NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    "leased_until" TIMESTAMPTZ(3),
    "last_error" TEXT,
    "enrolled_at" TIMESTAMPTZ(3),
    "removing_at" TIMESTAMPTZ(3),
    "removed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    CONSTRAINT "gate_face_enrollments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "gate_face_enrollments_tenant_id_id_key"
  ON "gate_face_enrollments"("tenant_id", "id");
-- One live template an entry: pending or enrolled.
CREATE UNIQUE INDEX "gate_face_enrollments_live_key"
  ON "gate_face_enrollments"("tenant_id", "entry_id")
  WHERE "status" IN ('pending', 'enrolled');
-- The sweep's work: what is to enrol or to remove, by when it is due.
CREATE INDEX "gate_face_enrollments_due_idx"
  ON "gate_face_enrollments"("tenant_id", "next_attempt_at")
  WHERE "status" IN ('pending', 'removing');
-- What a vendor's candidate is: an enrolled template.
CREATE INDEX "gate_face_enrollments_template_idx"
  ON "gate_face_enrollments"("tenant_id", "template_ref")
  WHERE "status" = 'enrolled';
ALTER TABLE "gate_face_enrollments"
  ADD CONSTRAINT "gate_face_enrollments_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_face_enrollments_entry_fkey"
  FOREIGN KEY ("tenant_id", "entry_id") REFERENCES "blocklist_entries"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "gate_face_enrollments" ADD CONSTRAINT "gate_face_enrollments_status"
  CHECK ("status" IN ('pending', 'enrolled', 'removing', 'removed'));
ALTER TABLE "gate_face_enrollments" ADD CONSTRAINT "gate_face_enrollments_error"
  CHECK ("last_error" IS NULL
      OR "last_error" IN ('timeout', 'unavailable', 'rejected', 'bad_response', 'off'));
ALTER TABLE "gate_face_enrollments" ADD CONSTRAINT "gate_face_enrollments_template"
  CHECK ("template_ref" IS NULL OR char_length("template_ref") BETWEEN 1 AND 200);
-- Each status's shape: enrolled holds its template; removed holds none.
ALTER TABLE "gate_face_enrollments" ADD CONSTRAINT "gate_face_enrollments_shape"
  CHECK ("attempts" >= 0
     AND ("status" <> 'enrolled' OR ("template_ref" IS NOT NULL AND "enrolled_at" IS NOT NULL))
     AND ("status" NOT IN ('removing', 'removed') OR "removing_at" IS NOT NULL)
     AND ("status" <> 'removed' OR ("template_ref" IS NULL AND "removed_at" IS NOT NULL))
     AND ("status" = 'removed' OR "removed_at" IS NULL));

-- An enrolment moves forward: pending → enrolled → removing → removed, or
-- pending → removing; removed is final. Its entry and birth never change.
CREATE OR REPLACE FUNCTION gate_face_enrollment_moves_forward() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."entry_id" = OLD."entry_id"
     AND NEW."created_at" = OLD."created_at"
     AND (NEW."status" = OLD."status"
          OR (OLD."status" = 'pending' AND NEW."status" IN ('enrolled', 'removing'))
          OR (OLD."status" = 'enrolled' AND NEW."status" = 'removing')
          OR (OLD."status" = 'removing' AND NEW."status" = 'removed'))
     AND OLD."status" <> 'removed'
     AND (OLD."enrolled_at" IS NULL OR NEW."enrolled_at" = OLD."enrolled_at")
     AND (OLD."removing_at" IS NULL OR NEW."removing_at" = OLD."removing_at") THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'gate_face_enrollments: an enrolment only moves forward (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER gate_face_enrollments_moves_forward
  BEFORE UPDATE OR DELETE ON "gate_face_enrollments"
  FOR EACH ROW EXECUTE FUNCTION gate_face_enrollment_moves_forward();
CREATE TRIGGER gate_face_enrollments_no_truncate
  BEFORE TRUNCATE ON "gate_face_enrollments"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

CREATE TABLE "gate_face_checks" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "shift_id" UUID NOT NULL,
    "gate_id" UUID NOT NULL,
    "guard_account_id" UUID NOT NULL,
    "probe_file_id" UUID,
    "outcome" TEXT,
    "matches" SMALLINT,
    "checked_at" TIMESTAMPTZ(3),
    "probe_deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    CONSTRAINT "gate_face_checks_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "gate_face_checks_tenant_id_id_key"
  ON "gate_face_checks"("tenant_id", "id");
-- A probe is one check's.
CREATE UNIQUE INDEX "gate_face_checks_probe_key"
  ON "gate_face_checks"("tenant_id", "probe_file_id");
-- The purge's work: probes still held, oldest first.
CREATE INDEX "gate_face_checks_probe_idx"
  ON "gate_face_checks"("tenant_id", "created_at")
  WHERE "probe_deleted_at" IS NULL;
ALTER TABLE "gate_face_checks"
  ADD CONSTRAINT "gate_face_checks_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_face_checks_shift_fkey"
  FOREIGN KEY ("tenant_id", "shift_id") REFERENCES "guard_shifts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_face_checks_gate_fkey"
  FOREIGN KEY ("tenant_id", "gate_id") REFERENCES "gates"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_face_checks_guard_fkey"
  FOREIGN KEY ("tenant_id", "guard_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_face_checks_probe_fkey"
  FOREIGN KEY ("tenant_id", "probe_file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "gate_face_checks" ADD CONSTRAINT "gate_face_checks_outcome"
  CHECK ("outcome" IS NULL OR "outcome" IN ('no_match', 'possible_match', 'unavailable'));
-- Answered once, with how many entries it met; the probe goes once.
ALTER TABLE "gate_face_checks" ADD CONSTRAINT "gate_face_checks_shape"
  CHECK (("outcome" IS NULL) = ("checked_at" IS NULL)
     AND ("outcome" IS NULL) = ("matches" IS NULL)
     AND ("matches" IS NULL OR "matches" >= 0)
     AND ("outcome" IS DISTINCT FROM 'possible_match' OR "matches" > 0)
     AND ("outcome" IS DISTINCT FROM 'no_match' OR "matches" = 0)
     AND ("outcome" IS DISTINCT FROM 'unavailable' OR "matches" = 0)
     AND (("probe_file_id" IS NULL) = ("probe_deleted_at" IS NOT NULL)));

-- A check is answered once and its probe deleted once; nothing else moves.
CREATE OR REPLACE FUNCTION gate_face_check_answered_once() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."shift_id" = OLD."shift_id"
     AND NEW."gate_id" = OLD."gate_id"
     AND NEW."guard_account_id" = OLD."guard_account_id"
     AND NEW."created_at" = OLD."created_at"
     AND (OLD."outcome" IS NULL
          OR (NEW."outcome" = OLD."outcome" AND NEW."matches" = OLD."matches"
              AND NEW."checked_at" = OLD."checked_at"))
     AND (NEW."probe_file_id" IS NOT DISTINCT FROM OLD."probe_file_id"
          OR (OLD."probe_file_id" IS NOT NULL AND NEW."probe_file_id" IS NULL))
     AND (OLD."probe_deleted_at" IS NULL OR NEW."probe_deleted_at" = OLD."probe_deleted_at") THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'gate_face_checks: a check is answered once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER gate_face_checks_answered_once
  BEFORE UPDATE OR DELETE ON "gate_face_checks"
  FOR EACH ROW EXECUTE FUNCTION gate_face_check_answered_once();
CREATE TRIGGER gate_face_checks_no_truncate
  BEFORE TRUNCATE ON "gate_face_checks"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Grants: both are locked FOR UPDATE (the sweep's lease, the answer).
-- ----------------------------------------------------------------------------
REVOKE ALL ON "gate_face_enrollments", "gate_face_checks" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "gate_face_enrollments", "gate_face_checks" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['gate_face_enrollments', 'gate_face_checks'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- A face check meets the blocklist as `face` (ADR 0068), an ID scan as
-- `id_scan`; both noted, never a refusal by themselves.
ALTER TABLE "blocklist_matches" DROP CONSTRAINT "blocklist_matches_source";
ALTER TABLE "blocklist_matches" ADD CONSTRAINT "blocklist_matches_source"
  CHECK ("source" IN ('visitor_pass', 'move_permit', 'event_guest', 'gate_request', 'verify', 'entry',
                      'plate_lookup', 'id_lookup', 'field_exception', 'service_vehicle',
                      'offline_sync', 'face', 'id_scan'));
-- What a face check met is tied to it (subject `face_check`), so the check
-- reads its matches back.
ALTER TABLE "blocklist_matches" DROP CONSTRAINT "blocklist_matches_subject";
ALTER TABLE "blocklist_matches" ADD CONSTRAINT "blocklist_matches_subject"
  CHECK (("subject_type" IS NULL) = ("subject_id" IS NULL)
     AND ("subject_type" IS NULL
          OR "subject_type" IN ('visitor_pass', 'gate_request', 'event_guest', 'move_permit',
                                'field_exception', 'service_vehicle', 'face_check')));
