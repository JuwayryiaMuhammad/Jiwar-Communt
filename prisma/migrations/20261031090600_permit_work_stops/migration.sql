-- ============================================================================
-- Security (ADR 0053): stop work. A guard on shift, or the permits' staff,
-- stops the work of an approved works permit with a reason code; its
-- workers are refused at the gate (`work_stopped`) until the management
-- resumes it, or the permit ends (revoked or cancelled).
--
-- * A stop points at a works permit only: the composite key on
--   (tenant, permit, kind) and a CHECK on the kind.
-- * One live stop per permit: decided under the permit's row lock, which a
--   worker's entry takes FOR SHARE, with a partial unique index behind it.
-- * Stopped once, ended once; what stopped it never changes. Never deleted.
-- ============================================================================

CREATE TABLE "permit_work_stops" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "permit_id" UUID NOT NULL,
    -- Always 'works': the foreign key below points at a works permit only.
    "permit_kind" "unit_permit_kind" NOT NULL DEFAULT 'works',
    "stopped_by_account_id" UUID NOT NULL,
    -- The guard's shift; NULL when the staff stopped it.
    "stopped_shift_id" UUID,
    "reason_code" TEXT NOT NULL,
    "stopped_at" TIMESTAMPTZ(3) NOT NULL,
    "ended_at" TIMESTAMPTZ(3),
    "ended_by_account_id" UUID,
    "end_kind" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "permit_work_stops_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "permit_work_stops_tenant_id_id_key" ON "permit_work_stops"("tenant_id", "id");
CREATE UNIQUE INDEX "permit_work_stops_one_live"
  ON "permit_work_stops"("tenant_id", "permit_id") WHERE "ended_at" IS NULL;
CREATE INDEX "permit_work_stops_permit_idx"
  ON "permit_work_stops"("tenant_id", "permit_id", "stopped_at", "id");
ALTER TABLE "permit_work_stops"
  ADD CONSTRAINT "permit_work_stops_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "permit_work_stops_permit_fkey"
  FOREIGN KEY ("tenant_id", "permit_id", "permit_kind")
  REFERENCES "unit_permits"("tenant_id", "id", "kind")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "permit_work_stops_stopped_by_fkey"
  FOREIGN KEY ("tenant_id", "stopped_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "permit_work_stops_shift_fkey"
  FOREIGN KEY ("tenant_id", "stopped_shift_id") REFERENCES "guard_shifts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "permit_work_stops_ended_by_fkey"
  FOREIGN KEY ("tenant_id", "ended_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "permit_work_stops" ADD CONSTRAINT "permit_work_stops_kind"
  CHECK ("permit_kind" = 'works');
-- REASON_CODES.permitWorkStop; a unit test keeps them in step.
ALTER TABLE "permit_work_stops" ADD CONSTRAINT "permit_work_stops_reason"
  CHECK ("reason_code" IN ('safety_hazard', 'outside_hours', 'noise_complaint', 'unauthorized_work', 'damage', 'other'));
-- Ended: when and how together; a resume names who.
ALTER TABLE "permit_work_stops" ADD CONSTRAINT "permit_work_stops_end_shape"
  CHECK (("ended_at" IS NULL) = ("end_kind" IS NULL)
     AND ("end_kind" IS NULL
          OR ("end_kind" = 'resumed' AND "ended_by_account_id" IS NOT NULL)
          OR "end_kind" IN ('permit_revoked', 'permit_cancelled'))
     AND ("ended_by_account_id" IS NULL OR "ended_at" IS NOT NULL)
     AND ("ended_at" IS NULL OR "ended_at" >= "stopped_at"));

CREATE FUNCTION permit_work_stop_moves_forward() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."permit_id" = OLD."permit_id"
     AND NEW."permit_kind" = OLD."permit_kind"
     AND NEW."stopped_by_account_id" = OLD."stopped_by_account_id"
     AND NEW."stopped_shift_id" IS NOT DISTINCT FROM OLD."stopped_shift_id"
     AND NEW."reason_code" = OLD."reason_code"
     AND NEW."stopped_at" = OLD."stopped_at"
     AND OLD."ended_at" IS NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'permit_work_stops: a stop is ended once and never deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER permit_work_stops_move_forward
  BEFORE UPDATE OR DELETE ON "permit_work_stops"
  FOR EACH ROW EXECUTE FUNCTION permit_work_stop_moves_forward();
CREATE TRIGGER permit_work_stops_move_forward_truncate
  BEFORE TRUNCATE ON "permit_work_stops"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "permit_work_stops" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "permit_work_stops" TO jiwar_app;
ALTER TABLE "permit_work_stops" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "permit_work_stops" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "permit_work_stops"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
