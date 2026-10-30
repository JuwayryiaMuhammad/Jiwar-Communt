-- ============================================================================
-- Technician safety (ADR 0067): a technician's incident and SOS, from the
-- ticket in their hands, with no shift.
--
-- * An incident may name the ticket it came from (an injury, a near miss,
--   a hazard): it is somewhere — a place, a unit, or that ticket (a common
--   area's work) — and its ticket never changes (the trigger, recreated).
-- * An emergency comes from a unit, a guard's post, or a technician's
--   ticket: exactly one; a shift only for a gate or a zone. One open SOS
--   per ticket, decided under the ticket's emergency lock, with a partial
--   unique index behind it; its ticket never changes (the trigger,
--   recreated).
-- * A staff member's SOS may be asked to be called off by who raised it:
--   recorded once, with an `emergencyCancel` code or none, and told to the
--   responders — but it stays open until a responder or the management
--   resolves it. Someone under duress can be made to cancel.
-- ============================================================================

ALTER TABLE "incidents" ADD COLUMN "ticket_id" UUID;
ALTER TABLE "incidents"
  ADD CONSTRAINT "incidents_tenant_id_ticket_fkey"
  FOREIGN KEY ("tenant_id", "ticket_id") REFERENCES "tickets"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE INDEX "incidents_ticket_idx" ON "incidents"("tenant_id", "ticket_id") WHERE "ticket_id" IS NOT NULL;
ALTER TABLE "incidents" DROP CONSTRAINT "incidents_where";
-- Somewhere: a place, a unit, or the ticket it came from.
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_where"
  CHECK (num_nonnulls("place_id", "unit_id", "ticket_id") >= 1);
-- A technician's report names its ticket and no post.
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_ticket_no_post"
  CHECK ("ticket_id" IS NULL OR "shift_id" IS NULL);

CREATE OR REPLACE FUNCTION incident_moves_forward() RETURNS trigger
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
     AND NEW."ticket_id" IS NOT DISTINCT FROM OLD."ticket_id"
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

ALTER TABLE "emergencies" ADD COLUMN "origin_ticket_id" UUID;
ALTER TABLE "emergencies"
  ADD CONSTRAINT "emergencies_tenant_id_origin_ticket_fkey"
  FOREIGN KEY ("tenant_id", "origin_ticket_id") REFERENCES "tickets"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "emergencies" DROP CONSTRAINT "emergencies_origin";
-- From a unit, a post on a shift, or a technician's ticket: one place it
-- came from; a shift only for a gate or a zone.
ALTER TABLE "emergencies" ADD CONSTRAINT "emergencies_origin"
  CHECK (num_nonnulls("unit_id", "origin_gate_id", "origin_place_id", "origin_ticket_id") = 1
     AND ("origin_shift_id" IS NOT NULL) = ("origin_gate_id" IS NOT NULL OR "origin_place_id" IS NOT NULL));
-- Who raised it asked for it to be called off: once, while it is open.
ALTER TABLE "emergencies"
  ADD COLUMN "cancel_requested_at" TIMESTAMPTZ(3),
  ADD COLUMN "cancel_request_reason" TEXT;
ALTER TABLE "emergencies" ADD CONSTRAINT "emergencies_cancel_request"
  CHECK (("cancel_request_reason" IS NULL OR "cancel_requested_at" IS NOT NULL)
     AND ("cancel_request_reason" IS NULL
          OR "cancel_request_reason" IN ('false_alarm', 'resolved_ourselves', 'other')));
-- One open SOS per ticket.
CREATE UNIQUE INDEX "emergencies_one_open_per_ticket"
  ON "emergencies"("tenant_id", "origin_ticket_id")
  WHERE "origin_ticket_id" IS NOT NULL AND "status" IN ('reported', 'on_the_way', 'arrived');

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
