-- ============================================================================
-- Emergencies and gate services (ADR 0047): what a resident asks security
-- for, in one table.
--
-- - accessibility: help for someone of the household (a wheelchair, someone
--   to walk with, a golf cart, bags), from a place to a place or home, now
--   or in 15 or 30 minutes;
-- - suspicious: something seen somewhere, in the resident's words, with a
--   photo;
-- - escort: security walks with them from a place to a place;
-- - lane: a gate opens a lane for an ambulance, a fire truck, a moving truck
--   or a large delivery, with a note.
--
-- open → accepted → in_progress → closed, or cancelled: by the requester
-- while open, by the system when the requester is erased. Security accepts
-- (with the minutes it expects to take), starts and closes it with a reason
-- code and a note of its own. What the resident wrote and their photo go
-- with their erasure, once; the row and the staff's note stay. Never
-- deleted.
-- ============================================================================

CREATE TYPE "gate_service_kind" AS ENUM ('accessibility', 'suspicious', 'escort', 'lane');
CREATE TYPE "gate_service_status" AS ENUM ('open', 'accepted', 'in_progress', 'closed', 'cancelled');

CREATE TABLE "gate_service_requests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    -- A- numbers for accessibility, S- for the rest (safety_counters).
    "number" INTEGER NOT NULL,
    "kind" "gate_service_kind" NOT NULL,
    "status" "gate_service_status" NOT NULL DEFAULT 'open',
    "unit_id" UUID NOT NULL,
    "requested_by_account_id" UUID NOT NULL,
    "assistance_kind" TEXT,
    -- The household member helped; null: the requester.
    "member_id" UUID,
    "from_place_id" UUID,
    -- null for accessibility: to the unit.
    "to_place_id" UUID,
    "place_id" UUID,
    "when_code" TEXT,
    "wanted_at" TIMESTAMPTZ(3),
    "description" TEXT,
    "photo_file_id" UUID,
    "lane_reason" TEXT,
    "gate_id" UUID,
    "notes" TEXT,
    "text_cleared_at" TIMESTAMPTZ(3),
    "handled_by_account_id" UUID,
    "eta_minutes" INTEGER,
    "accepted_at" TIMESTAMPTZ(3),
    "started_at" TIMESTAMPTZ(3),
    "closed_at" TIMESTAMPTZ(3),
    "closed_by_account_id" UUID,
    "close_reason" TEXT,
    -- The staff's words on closing it: kept through any erasure.
    "close_note" TEXT,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_side" TEXT,
    "cancel_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "gate_service_requests_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "gate_service_requests_tenant_id_id_key"
  ON "gate_service_requests"("tenant_id", "id");
-- One number per series: A- (accessibility) and S- (the rest).
CREATE UNIQUE INDEX "gate_service_requests_number_key"
  ON "gate_service_requests"("tenant_id", ("kind" = 'accessibility'), "number");
CREATE INDEX "gate_service_requests_status_idx"
  ON "gate_service_requests"("tenant_id", "status", "created_at", "id");
CREATE INDEX "gate_service_requests_requester_idx"
  ON "gate_service_requests"("tenant_id", "requested_by_account_id", "created_at", "id");
CREATE INDEX "gate_service_requests_unit_idx"
  ON "gate_service_requests"("tenant_id", "unit_id", "kind", "status");
ALTER TABLE "gate_service_requests"
  ADD CONSTRAINT "gate_service_requests_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_service_requests_unit_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_service_requests_requester_fkey"
  FOREIGN KEY ("tenant_id", "requested_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_service_requests_member_fkey"
  FOREIGN KEY ("tenant_id", "member_id") REFERENCES "household_members"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_service_requests_from_place_fkey"
  FOREIGN KEY ("tenant_id", "from_place_id") REFERENCES "places"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_service_requests_to_place_fkey"
  FOREIGN KEY ("tenant_id", "to_place_id") REFERENCES "places"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_service_requests_place_fkey"
  FOREIGN KEY ("tenant_id", "place_id") REFERENCES "places"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_service_requests_photo_fkey"
  FOREIGN KEY ("tenant_id", "photo_file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_service_requests_gate_fkey"
  FOREIGN KEY ("tenant_id", "gate_id") REFERENCES "gates"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_service_requests_handled_by_fkey"
  FOREIGN KEY ("tenant_id", "handled_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_service_requests_closed_by_fkey"
  FOREIGN KEY ("tenant_id", "closed_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "gate_service_requests" ADD CONSTRAINT "gate_service_requests_number_positive"
  CHECK ("number" > 0);
-- What each kind carries, and nothing else. kind is NOT NULL.
ALTER TABLE "gate_service_requests" ADD CONSTRAINT "gate_service_requests_kind_shape"
  CHECK (("kind" = 'accessibility') = ("assistance_kind" IS NOT NULL)
     AND ("member_id" IS NULL OR "kind" = 'accessibility')
     AND ("kind" IN ('accessibility', 'escort')) = ("from_place_id" IS NOT NULL)
     AND ("kind" IN ('accessibility', 'escort')) = ("when_code" IS NOT NULL)
     AND ("when_code" IS NULL) = ("wanted_at" IS NULL)
     AND ("kind" <> 'escort' OR "to_place_id" IS NOT NULL)
     AND ("to_place_id" IS NULL OR "kind" IN ('accessibility', 'escort'))
     AND ("kind" = 'suspicious') = ("place_id" IS NOT NULL)
     AND ("kind" = 'suspicious' OR ("description" IS NULL AND "photo_file_id" IS NULL))
     AND ("kind" <> 'suspicious' OR "description" IS NOT NULL OR "text_cleared_at" IS NOT NULL)
     AND ("kind" = 'lane') = ("lane_reason" IS NOT NULL)
     AND ("kind" = 'lane') = ("gate_id" IS NOT NULL)
     AND ("kind" = 'lane' OR "notes" IS NULL));
-- REASON_CODES.assistanceKind, gateServiceWhen, laneReason and
-- gateServiceClose; a unit test keeps them in step.
ALTER TABLE "gate_service_requests" ADD CONSTRAINT "gate_service_requests_assistance_kind"
  CHECK ("assistance_kind" IS NULL
      OR "assistance_kind" IN ('wheelchair', 'walk_with', 'golf_cart', 'bags'));
ALTER TABLE "gate_service_requests" ADD CONSTRAINT "gate_service_requests_when"
  CHECK ("when_code" IS NULL OR "when_code" IN ('now', 'in_15', 'in_30'));
ALTER TABLE "gate_service_requests" ADD CONSTRAINT "gate_service_requests_lane_reason"
  CHECK ("lane_reason" IS NULL
      OR "lane_reason" IN ('ambulance', 'fire_truck', 'moving_truck', 'large_delivery'));
ALTER TABLE "gate_service_requests" ADD CONSTRAINT "gate_service_requests_close_reason"
  CHECK ("close_reason" IS NULL
      OR "close_reason" IN ('done', 'not_found', 'no_show', 'duplicate', 'not_possible'));
ALTER TABLE "gate_service_requests" ADD CONSTRAINT "gate_service_requests_eta"
  CHECK ("eta_minutes" IS NULL OR "eta_minutes" IN (2, 5, 10, 15));
ALTER TABLE "gate_service_requests" ADD CONSTRAINT "gate_service_requests_text_length"
  CHECK (("description" IS NULL OR char_length("description") BETWEEN 1 AND 1000)
     AND ("notes" IS NULL OR char_length("notes") BETWEEN 1 AND 500)
     AND ("close_note" IS NULL OR char_length("close_note") BETWEEN 1 AND 500));
ALTER TABLE "gate_service_requests" ADD CONSTRAINT "gate_service_requests_text_cleared"
  CHECK ("text_cleared_at" IS NULL
      OR ("description" IS NULL AND "notes" IS NULL AND "photo_file_id" IS NULL));
-- The status agrees with the times. status is NOT NULL.
ALTER TABLE "gate_service_requests" ADD CONSTRAINT "gate_service_requests_state_shape"
  CHECK (("accepted_at" IS NULL) = ("handled_by_account_id" IS NULL)
     AND ("eta_minutes" IS NULL OR "accepted_at" IS NOT NULL)
     AND ("started_at" IS NULL OR "accepted_at" IS NOT NULL)
     AND ("status" <> 'open' OR ("accepted_at" IS NULL AND "closed_at" IS NULL AND "cancelled_at" IS NULL))
     AND ("status" <> 'accepted' OR ("accepted_at" IS NOT NULL AND "started_at" IS NULL))
     AND ("status" <> 'in_progress' OR "started_at" IS NOT NULL)
     AND ("status" = 'closed') = ("closed_at" IS NOT NULL)
     AND ("closed_at" IS NULL) = ("closed_by_account_id" IS NULL)
     AND ("closed_at" IS NULL) = ("close_reason" IS NULL)
     AND ("close_note" IS NULL OR "closed_at" IS NOT NULL)
     AND ("status" = 'cancelled') = ("cancelled_at" IS NOT NULL)
     AND ("cancelled_at" IS NULL) = ("cancel_side" IS NULL));
-- The requester cancels while open, with no reason; the system when the
-- requester is erased.
ALTER TABLE "gate_service_requests" ADD CONSTRAINT "gate_service_requests_cancel"
  CHECK ("cancel_side" IS NULL
      OR ("cancel_side" = 'requester' AND "cancel_reason" IS NULL AND "accepted_at" IS NULL)
      OR ("cancel_side" = 'system' AND "cancel_reason" IS NOT NULL AND "cancel_reason" IN ('requester_left')));
ALTER TABLE "gate_service_requests" ADD CONSTRAINT "gate_service_requests_cancel_reason_side"
  CHECK ("cancel_reason" IS NULL OR "cancel_side" IS NOT NULL);

-- A request keeps what it asks; it moves forward only, is handled once per
-- step, and what the resident wrote goes once (their erasure). Never deleted.
CREATE FUNCTION gate_service_request_moves_forward() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."number" = OLD."number"
     AND NEW."kind" = OLD."kind"
     AND NEW."unit_id" = OLD."unit_id"
     AND NEW."requested_by_account_id" = OLD."requested_by_account_id"
     AND NEW."created_at" = OLD."created_at"
     AND NEW."assistance_kind" IS NOT DISTINCT FROM OLD."assistance_kind"
     AND NEW."member_id" IS NOT DISTINCT FROM OLD."member_id"
     AND NEW."from_place_id" IS NOT DISTINCT FROM OLD."from_place_id"
     AND NEW."to_place_id" IS NOT DISTINCT FROM OLD."to_place_id"
     AND NEW."place_id" IS NOT DISTINCT FROM OLD."place_id"
     AND NEW."when_code" IS NOT DISTINCT FROM OLD."when_code"
     AND NEW."wanted_at" IS NOT DISTINCT FROM OLD."wanted_at"
     AND NEW."lane_reason" IS NOT DISTINCT FROM OLD."lane_reason"
     AND NEW."gate_id" IS NOT DISTINCT FROM OLD."gate_id"
     -- The resident's words and photo stay, or go together, once.
     AND ((NEW."description" IS NOT DISTINCT FROM OLD."description"
           AND NEW."notes" IS NOT DISTINCT FROM OLD."notes"
           AND NEW."photo_file_id" IS NOT DISTINCT FROM OLD."photo_file_id"
           AND NEW."text_cleared_at" IS NOT DISTINCT FROM OLD."text_cleared_at")
          OR (OLD."text_cleared_at" IS NULL AND NEW."text_cleared_at" IS NOT NULL
              AND NEW."description" IS NULL AND NEW."notes" IS NULL
              AND NEW."photo_file_id" IS NULL))
     AND (NEW."status" = OLD."status"
          OR (OLD."status" = 'open' AND NEW."status" IN ('accepted', 'closed', 'cancelled'))
          OR (OLD."status" = 'accepted' AND NEW."status" IN ('in_progress', 'closed', 'cancelled'))
          OR (OLD."status" = 'in_progress' AND NEW."status" IN ('closed', 'cancelled')))
     AND ((NEW."handled_by_account_id" IS NOT DISTINCT FROM OLD."handled_by_account_id"
           AND NEW."eta_minutes" IS NOT DISTINCT FROM OLD."eta_minutes"
           AND NEW."accepted_at" IS NOT DISTINCT FROM OLD."accepted_at")
          OR OLD."accepted_at" IS NULL)
     AND (NEW."started_at" IS NOT DISTINCT FROM OLD."started_at"
          OR OLD."started_at" IS NULL)
     AND ((NEW."closed_at" IS NOT DISTINCT FROM OLD."closed_at"
           AND NEW."closed_by_account_id" IS NOT DISTINCT FROM OLD."closed_by_account_id"
           AND NEW."close_reason" IS NOT DISTINCT FROM OLD."close_reason"
           AND NEW."close_note" IS NOT DISTINCT FROM OLD."close_note")
          OR OLD."closed_at" IS NULL)
     AND ((NEW."cancelled_at" IS NOT DISTINCT FROM OLD."cancelled_at"
           AND NEW."cancel_side" IS NOT DISTINCT FROM OLD."cancel_side"
           AND NEW."cancel_reason" IS NOT DISTINCT FROM OLD."cancel_reason")
          OR OLD."cancelled_at" IS NULL)
     -- Nothing of the handling changes once it is over.
     AND (OLD."status" NOT IN ('closed', 'cancelled')
          OR (NEW."status" = OLD."status"
              AND NEW."handled_by_account_id" IS NOT DISTINCT FROM OLD."handled_by_account_id"
              AND NEW."accepted_at" IS NOT DISTINCT FROM OLD."accepted_at"
              AND NEW."started_at" IS NOT DISTINCT FROM OLD."started_at")) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'gate_service_requests: a request keeps what it asks, moves forward only and is never deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER gate_service_requests_move_forward
  BEFORE UPDATE OR DELETE ON "gate_service_requests"
  FOR EACH ROW EXECUTE FUNCTION gate_service_request_moves_forward();
CREATE TRIGGER gate_service_requests_move_forward_truncate
  BEFORE TRUNCATE ON "gate_service_requests"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "gate_service_requests" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "gate_service_requests" TO jiwar_app;
ALTER TABLE "gate_service_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "gate_service_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "gate_service_requests"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
