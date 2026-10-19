-- ============================================================================
-- Patrol geofence (ADR 0056).
--
-- - `patrol_route_versions.geofence`: where a patrol of the route stays — a
--   circle `{"circle": {"lat", "lng", "radiusM"}}` or a simple polygon
--   `{"polygon": [[lat, lng], …]}` of 3 to 50 vertices. The geometry is
--   checked in code (src/gate/patrols/geofence.ts); here, the shape. Kept
--   with what the version says: its trigger is recreated with it.
-- - `gate_settings.geofence_exit_minutes`: how long outside makes an exit
--   worth flagging (3 by default).
-- - `patrol_geofence_exits`: each time a run's guard was outside. Opened by
--   the first point outside, closed by the next inside one. One per
--   (run, left_at), one open per run; flagged once (`flagged_at`), by the
--   track's upload or by the sweep, whichever sees it last long enough.
--   Times only: never a position.
-- - `incident_evidence` keeps a patrol run's track too (`patrol_track`,
--   `run_id`): the track purge leaves a linked run's points.
-- ============================================================================

ALTER TABLE "patrol_route_versions" ADD COLUMN "geofence" JSONB;
ALTER TABLE "patrol_route_versions" ADD CONSTRAINT "patrol_route_versions_geofence_shape"
  -- jsonb_typeof of a missing key is NULL, and a CHECK that is NULL passes:
  -- each type test is COALESCEd to '' so a missing key fails it, and the
  -- polygon's length is read only once it is an array.
  CHECK ("geofence" IS NULL
         OR (jsonb_typeof("geofence") = 'object'
             AND ((COALESCE(jsonb_typeof("geofence" -> 'circle'), '') = 'object'
                   AND NOT "geofence" ? 'polygon'
                   AND COALESCE(jsonb_typeof("geofence" -> 'circle' -> 'lat'), '') = 'number'
                   AND COALESCE(jsonb_typeof("geofence" -> 'circle' -> 'lng'), '') = 'number'
                   AND COALESCE(jsonb_typeof("geofence" -> 'circle' -> 'radiusM'), '') = 'number')
                  OR (NOT "geofence" ? 'circle'
                      AND CASE WHEN COALESCE(jsonb_typeof("geofence" -> 'polygon'), '') = 'array'
                               THEN jsonb_array_length("geofence" -> 'polygon') BETWEEN 3 AND 50
                               ELSE false END))));

CREATE OR REPLACE FUNCTION patrol_route_version_is_kept() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."route_id" = OLD."route_id"
     AND NEW."number" = OLD."number"
     AND NEW."ordered" = OLD."ordered"
     AND NEW."expected_minutes" = OLD."expected_minutes"
     AND NEW."schedule" IS NOT DISTINCT FROM OLD."schedule"
     AND NEW."geofence" IS NOT DISTINCT FROM OLD."geofence"
     AND NEW."created_by_account_id" = OLD."created_by_account_id"
     AND NEW."created_at" = OLD."created_at"
     AND (NEW."superseded_at" IS NOT DISTINCT FROM OLD."superseded_at"
          OR (OLD."superseded_at" IS NULL AND NEW."superseded_at" IS NOT NULL)) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'patrol_route_versions: what a version says never changes; it is superseded once and never deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

ALTER TABLE "gate_settings" ADD COLUMN "geofence_exit_minutes" SMALLINT NOT NULL DEFAULT 3;
ALTER TABLE "gate_settings" ADD CONSTRAINT "gate_settings_geofence_exit"
  CHECK ("geofence_exit_minutes" BETWEEN 1 AND 60);

CREATE TABLE "patrol_geofence_exits" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "guard_account_id" UUID NOT NULL,
    -- The device's times: the first point outside, the next one inside.
    "left_at" TIMESTAMPTZ(3) NOT NULL,
    "back_at" TIMESTAMPTZ(3),
    -- The server's: when it was flagged, and the threshold it passed.
    "flagged_at" TIMESTAMPTZ(3),
    "flagged_minutes" SMALLINT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "patrol_geofence_exits_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "patrol_geofence_exits_tenant_id_id_key" ON "patrol_geofence_exits"("tenant_id", "id");
-- Once per exit.
CREATE UNIQUE INDEX "patrol_geofence_exits_once_key"
  ON "patrol_geofence_exits"("tenant_id", "run_id", "left_at");
-- One open at a time.
CREATE UNIQUE INDEX "patrol_geofence_exits_open_key"
  ON "patrol_geofence_exits"("tenant_id", "run_id") WHERE "back_at" IS NULL;
-- The sweep's: open and not flagged.
CREATE INDEX "patrol_geofence_exits_waiting_idx"
  ON "patrol_geofence_exits"("tenant_id", "left_at")
  WHERE "back_at" IS NULL AND "flagged_at" IS NULL;
ALTER TABLE "patrol_geofence_exits"
  ADD CONSTRAINT "patrol_geofence_exits_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "patrol_geofence_exits_run_fkey"
    FOREIGN KEY ("tenant_id", "run_id") REFERENCES "patrol_runs"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "patrol_geofence_exits_guard_fkey"
    FOREIGN KEY ("tenant_id", "guard_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "patrol_geofence_exits_back_after_left"
    CHECK ("back_at" IS NULL OR "back_at" > "left_at"),
  ADD CONSTRAINT "patrol_geofence_exits_flag_shape"
    CHECK (("flagged_at" IS NULL) = ("flagged_minutes" IS NULL)),
  ADD CONSTRAINT "patrol_geofence_exits_flagged_minutes"
    CHECK ("flagged_minutes" IS NULL OR "flagged_minutes" BETWEEN 1 AND 60);

-- An exit's run, guard and start never change; it is closed once and
-- flagged once; never deleted.
CREATE FUNCTION patrol_geofence_exit_moves_forward() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."run_id" = OLD."run_id"
     AND NEW."guard_account_id" = OLD."guard_account_id"
     AND NEW."left_at" = OLD."left_at"
     AND NEW."created_at" = OLD."created_at"
     AND (NEW."back_at" IS NOT DISTINCT FROM OLD."back_at" OR OLD."back_at" IS NULL)
     AND ((NEW."flagged_at" IS NOT DISTINCT FROM OLD."flagged_at"
           AND NEW."flagged_minutes" IS NOT DISTINCT FROM OLD."flagged_minutes")
          OR OLD."flagged_at" IS NULL) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'patrol_geofence_exits: an exit is closed once, flagged once and never deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER patrol_geofence_exits_move_forward
  BEFORE UPDATE OR DELETE ON "patrol_geofence_exits"
  FOR EACH ROW EXECUTE FUNCTION patrol_geofence_exit_moves_forward();
CREATE TRIGGER patrol_geofence_exits_move_forward_truncate
  BEFORE TRUNCATE ON "patrol_geofence_exits"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "patrol_geofence_exits" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "patrol_geofence_exits" TO jiwar_app;
ALTER TABLE "patrol_geofence_exits" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "patrol_geofence_exits" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "patrol_geofence_exits"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ----------------------------------------------------------------------------
-- An incident keeps a run's track.
-- ----------------------------------------------------------------------------
ALTER TABLE "incident_evidence" ADD COLUMN "run_id" UUID;
ALTER TABLE "incident_evidence"
  ADD CONSTRAINT "incident_evidence_run_fkey"
    FOREIGN KEY ("tenant_id", "run_id") REFERENCES "patrol_runs"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "incident_evidence" DROP CONSTRAINT "incident_evidence_kind";
ALTER TABLE "incident_evidence" DROP CONSTRAINT "incident_evidence_shape";
ALTER TABLE "incident_evidence"
  ADD CONSTRAINT "incident_evidence_kind"
    CHECK ("kind" IN ('visitor_photo', 'patrol_track')),
  ADD CONSTRAINT "incident_evidence_shape"
    CHECK (("kind" = 'visitor_photo') = ("entry_id" IS NOT NULL)
           AND ("kind" = 'patrol_track') = ("run_id" IS NOT NULL));
CREATE UNIQUE INDEX "incident_evidence_run_key"
  ON "incident_evidence"("tenant_id", "incident_id", "run_id") WHERE "run_id" IS NOT NULL;
-- The purge asks whether a run is kept.
CREATE INDEX "incident_evidence_run_idx"
  ON "incident_evidence"("tenant_id", "run_id") WHERE "run_id" IS NOT NULL;
