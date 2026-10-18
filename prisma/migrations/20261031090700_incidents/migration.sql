-- ============================================================================
-- Security (ADR 0053): incidents.
--
-- A guard on shift, or the management, reports what happened: a type, a
-- severity, where (a place and/or a unit), when, the author's words, up to
-- five photos, and optional links to an emergency, a gate service request
-- or a patrol note. The management (`incidents.manage`) assigns an
-- investigator, writes internal notes and closes it with an outcome code
-- and a closing note. The author and a reviewer each acknowledge it once.
-- Residents never see incidents.
--
-- * The report never changes, but for an erasure clearing its author's
--   words (once). It moves forward: open → investigating → closed, or open
--   → closed; the investigator may change until it is closed; a closed one
--   changes no more, but for an erasure clearing the closer's words.
-- * Photos and acknowledgements are append-only; notes too, but for an
--   erasure clearing their words. Nothing is ever deleted.
-- ============================================================================

CREATE TABLE "incidents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "place_id" UUID,
    "unit_id" UUID,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    -- The author's words; NULL once an erasure cleared them.
    "description" TEXT,
    "reported_by_account_id" UUID NOT NULL,
    -- A guard's report: their shift and its post, for the daily report.
    "shift_id" UUID,
    "post_gate_id" UUID,
    "post_place_id" UUID,
    "emergency_id" UUID,
    "gate_service_request_id" UUID,
    "patrol_note_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'open',
    "investigator_account_id" UUID,
    "assigned_at" TIMESTAMPTZ(3),
    "outcome" TEXT,
    -- The closer's words, the management's only; NULL once an erasure
    -- cleared them.
    "closing_note" TEXT,
    "closed_by_account_id" UUID,
    "closed_at" TIMESTAMPTZ(3),
    "text_cleared_at" TIMESTAMPTZ(3),
    "closing_note_cleared_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "incidents_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "incidents_tenant_id_id_key" ON "incidents"("tenant_id", "id");
CREATE UNIQUE INDEX "incidents_number_key" ON "incidents"("tenant_id", "number");
CREATE INDEX "incidents_list_idx" ON "incidents"("tenant_id", "created_at", "id");
CREATE INDEX "incidents_author_idx"
  ON "incidents"("tenant_id", "reported_by_account_id", "created_at", "id");
CREATE INDEX "incidents_status_idx" ON "incidents"("tenant_id", "status", "created_at", "id");
ALTER TABLE "incidents"
  ADD CONSTRAINT "incidents_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "incidents_place_fkey"
  FOREIGN KEY ("tenant_id", "place_id") REFERENCES "places"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "incidents_unit_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "incidents_reported_by_fkey"
  FOREIGN KEY ("tenant_id", "reported_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "incidents_shift_fkey"
  FOREIGN KEY ("tenant_id", "shift_id") REFERENCES "guard_shifts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "incidents_post_gate_fkey"
  FOREIGN KEY ("tenant_id", "post_gate_id") REFERENCES "gates"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "incidents_post_place_fkey"
  FOREIGN KEY ("tenant_id", "post_place_id") REFERENCES "places"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "incidents_emergency_fkey"
  FOREIGN KEY ("tenant_id", "emergency_id") REFERENCES "emergencies"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "incidents_gate_service_fkey"
  FOREIGN KEY ("tenant_id", "gate_service_request_id") REFERENCES "gate_service_requests"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "incidents_patrol_note_fkey"
  FOREIGN KEY ("tenant_id", "patrol_note_id") REFERENCES "patrol_notes"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "incidents_investigator_fkey"
  FOREIGN KEY ("tenant_id", "investigator_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "incidents_closed_by_fkey"
  FOREIGN KEY ("tenant_id", "closed_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_number_positive"
  CHECK ("number" > 0);
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_type"
  CHECK ("type" IN ('injury', 'near_miss', 'hazard', 'security_breach', 'property_damage', 'fire', 'other'));
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_severity"
  CHECK ("severity" IN ('low', 'medium', 'high', 'critical'));
-- Somewhere: a place, a unit, or both.
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_where"
  CHECK (num_nonnulls("place_id", "unit_id") >= 1);
-- A guard's report names its post, one of a gate and a zone; the office's
-- names none.
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_post"
  CHECK (("shift_id" IS NULL AND "post_gate_id" IS NULL AND "post_place_id" IS NULL)
      OR ("shift_id" IS NOT NULL AND num_nonnulls("post_gate_id", "post_place_id") = 1));
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_description"
  CHECK (("description" IS NULL) = ("text_cleared_at" IS NOT NULL)
     AND ("description" IS NULL OR char_length("description") BETWEEN 1 AND 4000));
-- The status agrees with what was done. status is NOT NULL.
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_state_shape"
  CHECK ("status" IN ('open', 'investigating', 'closed')
     AND ("investigator_account_id" IS NULL) = ("assigned_at" IS NULL)
     AND ("status" <> 'investigating' OR "investigator_account_id" IS NOT NULL)
     AND ("status" <> 'open' OR "investigator_account_id" IS NULL)
     AND ("status" = 'closed') = ("closed_at" IS NOT NULL)
     AND ("closed_at" IS NULL) = ("closed_by_account_id" IS NULL)
     AND ("closed_at" IS NULL) = ("outcome" IS NULL));
-- REASON_CODES.incidentOutcome; a unit test keeps them in step.
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_outcome"
  CHECK ("outcome" IS NULL
      OR "outcome" IN ('resolved', 'referred_to_police', 'referred_to_management', 'no_action_needed', 'unfounded', 'other'));
-- A closing note on a close, until an erasure clears it.
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_closing_note"
  CHECK (("closing_note" IS NULL OR "closed_at" IS NOT NULL)
     AND ("closing_note_cleared_at" IS NULL OR ("closing_note" IS NULL AND "closed_at" IS NOT NULL))
     AND ("closed_at" IS NULL OR "closing_note" IS NOT NULL OR "closing_note_cleared_at" IS NOT NULL)
     AND ("closing_note" IS NULL OR char_length("closing_note") BETWEEN 1 AND 2000));

CREATE FUNCTION incident_moves_forward() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."number" = OLD."number"
     AND NEW."type" = OLD."type"
     AND NEW."severity" = OLD."severity"
     AND NEW."place_id" IS NOT DISTINCT FROM OLD."place_id"
     AND NEW."unit_id" IS NOT DISTINCT FROM OLD."unit_id"
     AND NEW."occurred_at" = OLD."occurred_at"
     AND NEW."reported_by_account_id" = OLD."reported_by_account_id"
     AND NEW."shift_id" IS NOT DISTINCT FROM OLD."shift_id"
     AND NEW."post_gate_id" IS NOT DISTINCT FROM OLD."post_gate_id"
     AND NEW."post_place_id" IS NOT DISTINCT FROM OLD."post_place_id"
     AND NEW."emergency_id" IS NOT DISTINCT FROM OLD."emergency_id"
     AND NEW."gate_service_request_id" IS NOT DISTINCT FROM OLD."gate_service_request_id"
     AND NEW."patrol_note_id" IS NOT DISTINCT FROM OLD."patrol_note_id"
     AND NEW."created_at" = OLD."created_at"
     -- The author's words: kept, or cleared once.
     AND (NEW."description" IS NOT DISTINCT FROM OLD."description"
          OR (OLD."text_cleared_at" IS NULL AND NEW."description" IS NULL))
     AND (NEW."text_cleared_at" IS NOT DISTINCT FROM OLD."text_cleared_at"
          OR OLD."text_cleared_at" IS NULL)
     -- Forward only.
     AND (NEW."status" = OLD."status"
          OR (OLD."status" = 'open' AND NEW."status" IN ('investigating', 'closed'))
          OR (OLD."status" = 'investigating' AND NEW."status" = 'closed'))
     -- Closed: nothing but the clearing of the closer's words, once.
     AND (OLD."status" <> 'closed'
          OR (NEW."investigator_account_id" IS NOT DISTINCT FROM OLD."investigator_account_id"
              AND NEW."assigned_at" IS NOT DISTINCT FROM OLD."assigned_at"
              AND NEW."outcome" = OLD."outcome"
              AND NEW."closed_by_account_id" = OLD."closed_by_account_id"
              AND NEW."closed_at" = OLD."closed_at"
              AND (NEW."closing_note" IS NOT DISTINCT FROM OLD."closing_note"
                   OR (OLD."closing_note_cleared_at" IS NULL AND NEW."closing_note" IS NULL))
              AND (NEW."closing_note_cleared_at" IS NOT DISTINCT FROM OLD."closing_note_cleared_at"
                   OR OLD."closing_note_cleared_at" IS NULL))) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'incidents: a report never changes, an incident moves forward only and is never deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER incidents_move_forward
  BEFORE UPDATE OR DELETE ON "incidents"
  FOR EACH ROW EXECUTE FUNCTION incident_moves_forward();
CREATE TRIGGER incidents_move_forward_truncate
  BEFORE TRUNCATE ON "incidents"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
CREATE TABLE "incident_photos" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "incident_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "uploaded_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "incident_photos_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "incident_photos_tenant_id_id_key" ON "incident_photos"("tenant_id", "id");
CREATE UNIQUE INDEX "incident_photos_file_key" ON "incident_photos"("file_id");
CREATE INDEX "incident_photos_incident_idx" ON "incident_photos"("tenant_id", "incident_id");
ALTER TABLE "incident_photos"
  ADD CONSTRAINT "incident_photos_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "incident_photos_incident_fkey"
  FOREIGN KEY ("tenant_id", "incident_id") REFERENCES "incidents"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "incident_photos_file_fkey"
  FOREIGN KEY ("tenant_id", "file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "incident_photos_uploaded_by_fkey"
  FOREIGN KEY ("tenant_id", "uploaded_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE TRIGGER incident_photos_immutable_rows
  BEFORE UPDATE OR DELETE ON "incident_photos"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER incident_photos_immutable_truncate
  BEFORE TRUNCATE ON "incident_photos"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
CREATE TABLE "incident_notes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "incident_id" UUID NOT NULL,
    "author_account_id" UUID NOT NULL,
    -- NULL once an erasure cleared its author's words.
    "body" TEXT,
    "text_cleared_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "incident_notes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "incident_notes_tenant_id_id_key" ON "incident_notes"("tenant_id", "id");
CREATE INDEX "incident_notes_incident_idx"
  ON "incident_notes"("tenant_id", "incident_id", "created_at", "id");
CREATE INDEX "incident_notes_author_idx" ON "incident_notes"("tenant_id", "author_account_id");
ALTER TABLE "incident_notes"
  ADD CONSTRAINT "incident_notes_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "incident_notes_incident_fkey"
  FOREIGN KEY ("tenant_id", "incident_id") REFERENCES "incidents"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "incident_notes_author_fkey"
  FOREIGN KEY ("tenant_id", "author_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "incident_notes" ADD CONSTRAINT "incident_notes_body"
  CHECK (("body" IS NULL) = ("text_cleared_at" IS NOT NULL)
     AND ("body" IS NULL OR char_length("body") BETWEEN 1 AND 2000));
CREATE FUNCTION incident_note_is_kept() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."incident_id" = OLD."incident_id"
     AND NEW."author_account_id" = OLD."author_account_id"
     AND NEW."created_at" = OLD."created_at"
     AND OLD."text_cleared_at" IS NULL
     AND NEW."body" IS NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'incident_notes: a note is kept, its words cleared once at most, never deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER incident_notes_kept
  BEFORE UPDATE OR DELETE ON "incident_notes"
  FOR EACH ROW EXECUTE FUNCTION incident_note_is_kept();
CREATE TRIGGER incident_notes_kept_truncate
  BEFORE TRUNCATE ON "incident_notes"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
CREATE TABLE "incident_acknowledgements" (
    "tenant_id" UUID NOT NULL,
    "incident_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "account_id" UUID NOT NULL,
    "acknowledged_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "incident_acknowledgements_pkey" PRIMARY KEY ("tenant_id", "incident_id", "role")
);
ALTER TABLE "incident_acknowledgements"
  ADD CONSTRAINT "incident_acknowledgements_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "incident_acknowledgements_incident_fkey"
  FOREIGN KEY ("tenant_id", "incident_id") REFERENCES "incidents"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "incident_acknowledgements_account_fkey"
  FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "incident_acknowledgements" ADD CONSTRAINT "incident_acknowledgements_role"
  CHECK ("role" IN ('author', 'reviewer'));
CREATE TRIGGER incident_acknowledgements_immutable_rows
  BEFORE UPDATE OR DELETE ON "incident_acknowledgements"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER incident_acknowledgements_immutable_truncate
  BEFORE TRUNCATE ON "incident_acknowledgements"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
REVOKE ALL ON "incidents", "incident_photos", "incident_notes", "incident_acknowledgements" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "incidents", "incident_notes" TO jiwar_app;
GRANT SELECT, INSERT ON "incident_photos", "incident_acknowledgements" TO jiwar_app;
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['incidents', 'incident_photos', 'incident_notes', 'incident_acknowledgements'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
