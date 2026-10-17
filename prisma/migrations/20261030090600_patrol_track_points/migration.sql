-- ============================================================================
-- Patrols (ADR 0052): where a guard walked during a run.
-- ============================================================================
--
-- The app sends its positions in batches during a run (and up to 30
-- minutes after it, from its offline queue). A point at the same instant
-- of the same run is kept once, so a batch sent again adds nothing. The
-- guard's location is personal data: it is read by `patrols.manage` and by
-- the guard on their own runs, deleted 30 days after it was recorded by a
-- sweep, and at the guard's erasure. A point never changes.

CREATE TABLE "patrol_track_points" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "guard_account_id" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "accuracy_m" DOUBLE PRECISION,
    "received_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "patrol_track_points_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "patrol_track_points_tenant_id_id_key" ON "patrol_track_points"("tenant_id", "id");
-- A point of a run at an instant, once: a batch sent again adds nothing.
CREATE UNIQUE INDEX "patrol_track_points_once_key"
  ON "patrol_track_points"("tenant_id", "run_id", "recorded_at");
CREATE INDEX "patrol_track_points_age_idx" ON "patrol_track_points"("tenant_id", "recorded_at");
CREATE INDEX "patrol_track_points_guard_idx" ON "patrol_track_points"("tenant_id", "guard_account_id");

ALTER TABLE "patrol_track_points"
  ADD CONSTRAINT "patrol_track_points_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "patrol_track_points_tenant_id_run_id_fkey"
    FOREIGN KEY ("tenant_id", "run_id") REFERENCES "patrol_runs"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "patrol_track_points_tenant_id_guard_account_id_fkey"
    FOREIGN KEY ("tenant_id", "guard_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "patrol_track_points_position_range"
    CHECK ("lat" BETWEEN -90 AND 90 AND "lng" BETWEEN -180 AND 180),
  ADD CONSTRAINT "patrol_track_points_accuracy_range"
    CHECK ("accuracy_m" IS NULL OR "accuracy_m" BETWEEN 0 AND 10000);

-- A point never changes. It is deleted (the 30-day purge, an erasure),
-- never truncated by the app.
CREATE FUNCTION patrol_track_point_never_changes() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'patrol_track_points: a point never changes (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER patrol_track_points_never_change
  BEFORE UPDATE ON "patrol_track_points"
  FOR EACH ROW EXECUTE FUNCTION patrol_track_point_never_changes();
CREATE TRIGGER patrol_track_points_never_change_truncate
  BEFORE TRUNCATE ON "patrol_track_points"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "patrol_track_points" FROM jiwar_app;
GRANT SELECT, INSERT, DELETE ON "patrol_track_points" TO jiwar_app;

ALTER TABLE "patrol_track_points" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "patrol_track_points" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "patrol_track_points"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
