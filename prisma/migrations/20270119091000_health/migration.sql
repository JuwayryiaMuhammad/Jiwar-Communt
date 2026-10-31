-- ============================================================================
-- Health (ADR 0071).
--
-- Emergency guides: four compound-document kinds — what to do in a medical
-- emergency, a fire, a security threat or a facilities failure (a gas leak,
-- a flood). The management publishes them as any compound document, never
-- announced; residents read the latest of each.
--
-- An emergency's place: a resident who is not at home reports from one of
-- the compound's common areas (the pool, the gym, a garden). The unit stays
-- the one the button belongs to; the area tells the responders where to go,
-- with its building. Frozen with the rest of the report; still no GPS.
-- ============================================================================

ALTER TABLE "compound_document_versions" DROP CONSTRAINT "compound_document_versions_kind";
ALTER TABLE "compound_document_versions" ADD CONSTRAINT "compound_document_versions_kind"
  CHECK ("kind" IN ('bylaws', 'occupant_rights', 'conduct_guide', 'moving_guide', 'saving_tips',
                    'emergency_medical', 'emergency_fire', 'emergency_security', 'emergency_facilities'));

ALTER TABLE "emergencies" ADD COLUMN "common_area_id" UUID;
ALTER TABLE "emergencies"
  ADD CONSTRAINT "emergencies_tenant_id_common_area_fkey"
  FOREIGN KEY ("tenant_id", "common_area_id") REFERENCES "common_areas"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- Only a resident's report from a unit names an area.
ALTER TABLE "emergencies" ADD CONSTRAINT "emergencies_common_area_shape"
  CHECK ("common_area_id" IS NULL OR "unit_id" IS NOT NULL);

-- The area is frozen with the rest of the report: the function is replaced
-- as its latest version (20261222090400) left it, with the one column more.
CREATE OR REPLACE FUNCTION emergency_moves_forward() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."number" = OLD."number"
     AND NEW."unit_id" IS NOT DISTINCT FROM OLD."unit_id"
     AND NEW."origin_gate_id" IS NOT DISTINCT FROM OLD."origin_gate_id"
     AND NEW."origin_place_id" IS NOT DISTINCT FROM OLD."origin_place_id"
     AND NEW."origin_shift_id" IS NOT DISTINCT FROM OLD."origin_shift_id"
     AND NEW."origin_ticket_id" IS NOT DISTINCT FROM OLD."origin_ticket_id"
     AND NEW."common_area_id" IS NOT DISTINCT FROM OLD."common_area_id"
     -- A request to call it off: recorded once.
     AND ((NEW."cancel_requested_at" IS NOT DISTINCT FROM OLD."cancel_requested_at"
           AND NEW."cancel_request_reason" IS NOT DISTINCT FROM OLD."cancel_request_reason")
          OR OLD."cancel_requested_at" IS NULL)
     AND NEW."type" = OLD."type"
     AND NEW."reported_by_account_id" = OLD."reported_by_account_id"
     AND NEW."reported_at" = OLD."reported_at"
     AND NEW."responders_notified" = OLD."responders_notified"
     -- Nothing changes once closed.
     AND OLD."closed_at" IS NULL
     AND (NEW."status" = OLD."status"
          OR (OLD."status" = 'reported' AND NEW."status" IN ('on_the_way', 'resolved', 'cancelled'))
          OR (OLD."status" = 'on_the_way' AND NEW."status" IN ('arrived', 'resolved', 'cancelled'))
          OR (OLD."status" = 'arrived' AND NEW."status" IN ('resolved', 'cancelled')))
     AND ((NEW."escalated_at" IS NOT DISTINCT FROM OLD."escalated_at"
           AND NEW."escalation_reason" IS NOT DISTINCT FROM OLD."escalation_reason")
          OR OLD."escalated_at" IS NULL)
     AND ((NEW."responder_account_id" IS NOT DISTINCT FROM OLD."responder_account_id"
           AND NEW."responder_gate_id" IS NOT DISTINCT FROM OLD."responder_gate_id"
           AND NEW."eta_minutes" IS NOT DISTINCT FROM OLD."eta_minutes"
           AND NEW."accepted_at" IS NOT DISTINCT FROM OLD."accepted_at")
          OR OLD."accepted_at" IS NULL)
     AND (NEW."arrived_at" IS NOT DISTINCT FROM OLD."arrived_at"
          OR OLD."arrived_at" IS NULL) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'emergencies: an emergency only moves forward and is never deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
