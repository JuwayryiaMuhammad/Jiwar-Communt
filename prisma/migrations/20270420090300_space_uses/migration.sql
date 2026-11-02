-- ============================================================================
-- Common-area use requests (ADR 0084): a resident asks to use a common area
-- (ADR 0064) the management opened to requests, for a time on one stretch
-- of at most 12 hours, with a purpose; the staff (`bookings.handle`) approve
-- it, or refuse it with a reason code. Approved uses of one area never
-- overlap, and an area that is a facility's never holds an approved use and
-- a booking at once: an approval takes the facility's row FOR UPDATE (a
-- booking holds it FOR SHARE) and then the area's row FOR UPDATE, and a
-- booking sees an approved use as the facility closed.
--
-- - space_use_areas: the common areas open to requests;
-- - space_use_requests: pending, approved, refused, cancelled (by the
--   requester or the unit's primary with a code, by the staff with a code,
--   or by the system when the requester left), or expired (still pending
--   when it would have started).
--
-- The purpose is the requester's words: plain data, never in the audit
-- trail or a notice, in their export, and NULL once they are erased. A
-- request keeps its area, unit, requester and time; a closed one changes
-- only its purpose's erasure.
-- ============================================================================

CREATE TABLE "space_use_areas" (
    "tenant_id" UUID NOT NULL,
    "common_area_id" UUID NOT NULL,
    "opened_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "space_use_areas_pkey" PRIMARY KEY ("tenant_id", "common_area_id")
);
ALTER TABLE "space_use_areas" ADD CONSTRAINT "space_use_areas_tenant_id_area_fkey"
  FOREIGN KEY ("tenant_id", "common_area_id") REFERENCES "common_areas"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE "space_use_requests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "common_area_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "requested_by_account_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "purpose" TEXT,
    "guests" SMALLINT NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "decided_by_account_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "reason_code" TEXT,
    "ended_at" TIMESTAMPTZ(3),
    "ended_by_account_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "space_use_requests_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "space_use_requests_tenant_id_id_key" ON "space_use_requests"("tenant_id", "id");
CREATE INDEX "space_use_requests_area_idx"
  ON "space_use_requests"("tenant_id", "common_area_id", "starts_at");
CREATE INDEX "space_use_requests_unit_idx"
  ON "space_use_requests"("tenant_id", "unit_id", "created_at" DESC, "id" DESC);
CREATE INDEX "space_use_requests_status_idx"
  ON "space_use_requests"("tenant_id", "status", "created_at", "id");
CREATE INDEX "space_use_requests_requester_idx"
  ON "space_use_requests"("tenant_id", "requested_by_account_id");
ALTER TABLE "space_use_requests"
  ADD CONSTRAINT "space_use_requests_tenant_id_area_fkey"
  FOREIGN KEY ("tenant_id", "common_area_id") REFERENCES "common_areas"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "space_use_requests_tenant_id_unit_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "space_use_requests_tenant_id_requested_by_fkey"
  FOREIGN KEY ("tenant_id", "requested_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "space_use_requests_tenant_id_decided_by_fkey"
  FOREIGN KEY ("tenant_id", "decided_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "space_use_requests_tenant_id_ended_by_fkey"
  FOREIGN KEY ("tenant_id", "ended_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "space_use_requests" ADD CONSTRAINT "space_use_requests_window"
  CHECK ("ends_at" > "starts_at" AND "ends_at" - "starts_at" <= interval '12 hours');
ALTER TABLE "space_use_requests" ADD CONSTRAINT "space_use_requests_fields"
  CHECK (("purpose" IS NULL OR char_length("purpose") BETWEEN 1 AND 500)
     AND "guests" BETWEEN 0 AND 500);
-- Pending: nothing decided or ended. Approved or refused: decided (a refusal
-- with its code). Cancelled: ended, with its code, decided or not. Expired:
-- ended by the sweep, never decided. Decided by someone exactly when decided;
-- ended by someone only on a cancel (the system's has nobody).
ALTER TABLE "space_use_requests" ADD CONSTRAINT "space_use_requests_status_shape"
  CHECK (CASE "status"
           WHEN 'pending' THEN "decided_at" IS NULL AND "ended_at" IS NULL AND "reason_code" IS NULL
           WHEN 'approved' THEN "decided_at" IS NOT NULL AND "ended_at" IS NULL AND "reason_code" IS NULL
           WHEN 'refused' THEN "decided_at" IS NOT NULL AND "ended_at" IS NULL AND "reason_code" IS NOT NULL
           WHEN 'cancelled' THEN "ended_at" IS NOT NULL AND "reason_code" IS NOT NULL
           WHEN 'expired' THEN "decided_at" IS NULL AND "ended_at" IS NOT NULL AND "reason_code" IS NULL
           ELSE false
         END
     AND (("decided_at" IS NULL) = ("decided_by_account_id" IS NULL))
     AND ("ended_by_account_id" IS NULL OR "status" = 'cancelled'));

-- A request keeps what it asked for; a closed one changes only by its
-- purpose's erasure (to NULL).
CREATE FUNCTION "space_use_requests_keep"() RETURNS trigger AS $$
BEGIN
  IF NEW."id" <> OLD."id" OR NEW."tenant_id" <> OLD."tenant_id"
     OR NEW."common_area_id" <> OLD."common_area_id"
     OR NEW."unit_id" <> OLD."unit_id"
     OR NEW."requested_by_account_id" <> OLD."requested_by_account_id"
     OR NEW."starts_at" <> OLD."starts_at" OR NEW."ends_at" <> OLD."ends_at"
     OR NEW."guests" <> OLD."guests" OR NEW."created_at" <> OLD."created_at"
     OR (NEW."purpose" IS DISTINCT FROM OLD."purpose" AND NEW."purpose" IS NOT NULL)
     OR (OLD."status" IN ('refused', 'cancelled', 'expired')
         AND (NEW."status" <> OLD."status"
              OR NEW."decided_at" IS DISTINCT FROM OLD."decided_at"
              OR NEW."ended_at" IS DISTINCT FROM OLD."ended_at"
              OR NEW."reason_code" IS DISTINCT FROM OLD."reason_code")) THEN
    RAISE EXCEPTION 'space_use_requests: a request keeps what it asked for, and a closed one stays closed'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "space_use_requests_keep" BEFORE UPDATE ON "space_use_requests"
  FOR EACH ROW EXECUTE FUNCTION "space_use_requests_keep"();

REVOKE ALL ON "space_use_areas", "space_use_requests" FROM jiwar_app;
GRANT SELECT, INSERT, DELETE ON "space_use_areas" TO jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "space_use_requests" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['space_use_areas', 'space_use_requests'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- The staff inbox (ADR 0073): a request waiting for the staff, beside every
-- type before it (ADR 0077's purchase request with them).
-- ----------------------------------------------------------------------------
ALTER TABLE "staff_inbox_due_hours" DROP CONSTRAINT "staff_inbox_due_hours_type";
ALTER TABLE "staff_inbox_due_hours" ADD CONSTRAINT "staff_inbox_due_hours_type"
  CHECK ("type" IN ('registration', 'identity_change', 'worker_engagement', 'vehicle',
    'booking', 'unit_permit', 'work_permit', 'field_exception', 'plan_request',
    'invoice_dispute', 'decision_appeal', 'management_request', 'purchase_request', 'space_use_request'));
ALTER TABLE "staff_inbox_overdue" DROP CONSTRAINT "staff_inbox_overdue_type";
ALTER TABLE "staff_inbox_overdue" ADD CONSTRAINT "staff_inbox_overdue_type"
  CHECK ("type" IN ('registration', 'identity_change', 'worker_engagement', 'vehicle',
    'booking', 'unit_permit', 'work_permit', 'field_exception', 'plan_request',
    'invoice_dispute', 'decision_appeal', 'management_request', 'purchase_request', 'space_use_request'));
