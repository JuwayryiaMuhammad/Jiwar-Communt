-- ============================================================================
-- Permits (ADR 0049): what a unit asks the management for, in one table.
--
-- - works: renovation or finishing, over a period of local days, within
--   daily hours, by a contractor company, with the resident's description;
--   its workers are registered one by one (permit_workers);
-- - move: furniture in or out on one day, within a window, by a truck (its
--   plate), with the resident's description of the items;
-- - material_exit: goods taken out of the compound, an item list and an
--   optional photo, valid for up to seven days; used once, at the gate;
-- - event: a private gathering in a window of up to 24 hours, with its guest
--   list (permit_guests). Up to 20 guests it is approved at once.
--
-- pending → approved | rejected | cancelled; approved → cancelled | revoked
-- | used (a material exit, once). The requester cancels; the system cancels
-- one nobody decided, or the requester's when they leave; the management
-- approves, rejects and revokes, with a reason code and a note of its own.
-- What the resident wrote and their photo go with their erasure, once; the
-- truck's plate and the photo go with the people's data 30 days after the
-- end (purged_at). The row and the staff's words stay. Never deleted.
-- ============================================================================

CREATE TYPE "unit_permit_kind" AS ENUM ('works', 'move', 'material_exit', 'event');
CREATE TYPE "unit_permit_status" AS ENUM ('pending', 'approved', 'rejected', 'cancelled', 'revoked', 'used');

-- ----------------------------------------------------------------------------
-- The numbers per kind (W-, M-, X-, E-), each taken under its counter's row
-- lock, last in the transaction. A rollback gives the number back.
-- ----------------------------------------------------------------------------
CREATE TABLE "permit_counters" (
    "tenant_id" UUID NOT NULL,
    "kind" "unit_permit_kind" NOT NULL,
    "last_number" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "permit_counters_pkey" PRIMARY KEY ("tenant_id", "kind")
);
ALTER TABLE "permit_counters" ADD CONSTRAINT "permit_counters_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "permit_counters" ADD CONSTRAINT "permit_counters_last_number"
  CHECK ("last_number" >= 0);

-- ----------------------------------------------------------------------------
-- The permits.
-- ----------------------------------------------------------------------------
CREATE TABLE "unit_permits" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "kind" "unit_permit_kind" NOT NULL,
    "status" "unit_permit_status" NOT NULL DEFAULT 'pending',
    "unit_id" UUID NOT NULL,
    "requested_by_account_id" UUID NOT NULL,
    -- works: the first local day's midnight and the midnight after the last;
    -- move and event: the window; material_exit: the validity's days.
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    -- works
    "work_type" TEXT,
    "daily_from" SMALLINT,
    "daily_to" SMALLINT,
    "contractor_company" TEXT,
    "description" TEXT,
    -- move
    "truck_plate" TEXT,
    "plate_key" TEXT GENERATED ALWAYS AS (
      translate(replace("truck_plate", ' ', ''), '٠١٢٣٤٥٦٧٨٩أإآىة', '0123456789ااايه')
    ) STORED,
    "items_description" TEXT,
    -- material_exit
    "items" JSONB,
    "photo_file_id" UUID,
    "used_at" TIMESTAMPTZ(3),
    "used_by_account_id" UUID,
    "used_gate_id" UUID,
    -- event
    "title" TEXT,
    -- The guests it may hold: 20 when approved at once, else the count the
    -- management was asked for (and approved).
    "guest_limit" INTEGER,
    -- The decision: by the management, or at once (an event of 20 or fewer).
    "decision_source" TEXT,
    "decided_by_account_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "reject_reason" TEXT,
    -- The management's words on deciding: kept through any erasure.
    "staff_note" TEXT,
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_by_account_id" UUID,
    "revoke_reason" TEXT,
    "revoke_note" TEXT,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by_account_id" UUID,
    "cancel_side" TEXT,
    "cancel_reason" TEXT,
    "text_cleared_at" TIMESTAMPTZ(3),
    "purged_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "unit_permits_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "unit_permits_tenant_id_id_key"
  ON "unit_permits"("tenant_id", "id");
-- What a worker or a guest points at: a permit of their kind.
CREATE UNIQUE INDEX "unit_permits_tenant_id_id_kind_key"
  ON "unit_permits"("tenant_id", "id", "kind");
CREATE UNIQUE INDEX "unit_permits_number_key"
  ON "unit_permits"("tenant_id", "kind", "number");
CREATE UNIQUE INDEX "unit_permits_photo_file_id_key"
  ON "unit_permits"("photo_file_id") WHERE "photo_file_id" IS NOT NULL;
CREATE INDEX "unit_permits_status_idx"
  ON "unit_permits"("tenant_id", "status", "created_at", "id");
CREATE INDEX "unit_permits_unit_idx"
  ON "unit_permits"("tenant_id", "unit_id", "kind", "status", "ends_at");
CREATE INDEX "unit_permits_requester_idx"
  ON "unit_permits"("tenant_id", "requested_by_account_id", "created_at", "id");
CREATE INDEX "unit_permits_live_idx"
  ON "unit_permits"("tenant_id", "starts_at", "ends_at")
  WHERE "status" = 'approved';
CREATE INDEX "unit_permits_plate_key_idx"
  ON "unit_permits"("tenant_id", "plate_key") WHERE "plate_key" IS NOT NULL;
CREATE INDEX "unit_permits_purge_idx"
  ON "unit_permits"("tenant_id", "ends_at") WHERE "purged_at" IS NULL;
ALTER TABLE "unit_permits"
  ADD CONSTRAINT "unit_permits_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_permits_unit_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_permits_requester_fkey"
  FOREIGN KEY ("tenant_id", "requested_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_permits_photo_fkey"
  FOREIGN KEY ("tenant_id", "photo_file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_permits_used_by_fkey"
  FOREIGN KEY ("tenant_id", "used_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_permits_used_gate_fkey"
  FOREIGN KEY ("tenant_id", "used_gate_id") REFERENCES "gates"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_permits_decided_by_fkey"
  FOREIGN KEY ("tenant_id", "decided_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_permits_revoked_by_fkey"
  FOREIGN KEY ("tenant_id", "revoked_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_permits_cancelled_by_fkey"
  FOREIGN KEY ("tenant_id", "cancelled_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "unit_permits" ADD CONSTRAINT "unit_permits_number_positive"
  CHECK ("number" > 0);
ALTER TABLE "unit_permits" ADD CONSTRAINT "unit_permits_window"
  CHECK ("starts_at" < "ends_at");
-- What each kind carries, and nothing else. kind is NOT NULL. The resident's
-- words may be gone (text_cleared_at), the plate and the photo too
-- (purged_at); nothing else of a kind is ever missing.
ALTER TABLE "unit_permits" ADD CONSTRAINT "unit_permits_kind_shape"
  CHECK (("kind" = 'works') = ("work_type" IS NOT NULL)
     AND ("kind" = 'works') = ("daily_from" IS NOT NULL)
     AND ("kind" = 'works') = ("daily_to" IS NOT NULL)
     AND ("kind" = 'works' OR ("contractor_company" IS NULL AND "description" IS NULL))
     AND ("kind" <> 'works' OR "text_cleared_at" IS NOT NULL
          OR ("contractor_company" IS NOT NULL AND "description" IS NOT NULL))
     AND ("kind" = 'move' OR ("truck_plate" IS NULL AND "items_description" IS NULL))
     AND ("kind" <> 'move' OR "purged_at" IS NOT NULL OR "truck_plate" IS NOT NULL)
     AND ("kind" <> 'move' OR "text_cleared_at" IS NOT NULL OR "items_description" IS NOT NULL)
     AND ("kind" = 'material_exit' OR ("items" IS NULL AND "photo_file_id" IS NULL
          AND "used_at" IS NULL))
     AND ("kind" <> 'material_exit' OR "text_cleared_at" IS NOT NULL OR "items" IS NOT NULL)
     AND ("kind" = 'event') = ("guest_limit" IS NOT NULL)
     AND ("kind" = 'event' OR "title" IS NULL));
ALTER TABLE "unit_permits" ADD CONSTRAINT "unit_permits_daily_hours"
  CHECK ("daily_from" IS NULL OR "daily_to" IS NULL
      OR ("daily_from" >= 0 AND "daily_from" < "daily_to" AND "daily_to" <= 1439));
ALTER TABLE "unit_permits" ADD CONSTRAINT "unit_permits_guest_limit"
  CHECK ("guest_limit" IS NULL OR "guest_limit" BETWEEN 1 AND 150);
ALTER TABLE "unit_permits" ADD CONSTRAINT "unit_permits_items_shape"
  CHECK ("items" IS NULL
      OR (jsonb_typeof("items") = 'array' AND jsonb_array_length("items") BETWEEN 1 AND 30));
ALTER TABLE "unit_permits" ADD CONSTRAINT "unit_permits_text_length"
  CHECK (("contractor_company" IS NULL OR char_length("contractor_company") BETWEEN 1 AND 120)
     AND ("description" IS NULL OR char_length("description") BETWEEN 1 AND 1000)
     AND ("truck_plate" IS NULL OR char_length("truck_plate") BETWEEN 1 AND 12)
     AND ("items_description" IS NULL OR char_length("items_description") BETWEEN 1 AND 1000)
     AND ("title" IS NULL OR char_length("title") BETWEEN 1 AND 120)
     AND ("staff_note" IS NULL OR char_length("staff_note") BETWEEN 1 AND 500)
     AND ("revoke_note" IS NULL OR char_length("revoke_note") BETWEEN 1 AND 500));
ALTER TABLE "unit_permits" ADD CONSTRAINT "unit_permits_text_cleared"
  CHECK ("text_cleared_at" IS NULL
      OR ("contractor_company" IS NULL AND "description" IS NULL
          AND "items_description" IS NULL AND "items" IS NULL
          AND "title" IS NULL AND "photo_file_id" IS NULL));
ALTER TABLE "unit_permits" ADD CONSTRAINT "unit_permits_purged"
  CHECK ("purged_at" IS NULL OR ("truck_plate" IS NULL AND "photo_file_id" IS NULL));
-- REASON_CODES.permitWorkType, unitPermitReject, unitPermitRevoke,
-- unitPermitCancel and unitPermitSystemCancel; a unit test keeps them in step.
ALTER TABLE "unit_permits" ADD CONSTRAINT "unit_permits_work_type"
  CHECK ("work_type" IS NULL OR "work_type" IN ('renovation', 'finishing'));
ALTER TABLE "unit_permits" ADD CONSTRAINT "unit_permits_reject_reason"
  CHECK ("reject_reason" IS NULL
      OR "reject_reason" IN ('missing_details', 'outside_rules', 'too_many_guests', 'safety_concern', 'other'));
ALTER TABLE "unit_permits" ADD CONSTRAINT "unit_permits_revoke_reason"
  CHECK ("revoke_reason" IS NULL
      OR "revoke_reason" IN ('rules_broken', 'safety_concern', 'complaint', 'other'));
-- The requester cancels, with a reason or none; the system with its own.
ALTER TABLE "unit_permits" ADD CONSTRAINT "unit_permits_cancel"
  CHECK ("cancel_side" IS NULL
      OR ("cancel_side" = 'requester' AND "cancelled_by_account_id" IS NOT NULL
          AND ("cancel_reason" IS NULL
               OR "cancel_reason" IN ('plans_changed', 'dates_changed', 'contractor_changed', 'other')))
      OR ("cancel_side" = 'system' AND "cancelled_by_account_id" IS NULL
          AND "cancel_reason" IS NOT NULL
          AND "cancel_reason" IN ('requester_left', 'not_decided')));
ALTER TABLE "unit_permits" ADD CONSTRAINT "unit_permits_cancel_reason_side"
  CHECK (("cancel_reason" IS NULL OR "cancel_side" IS NOT NULL)
     AND ("cancelled_by_account_id" IS NULL OR "cancel_side" IS NOT NULL));
-- The decision: the management's carries who; at once only for an event.
ALTER TABLE "unit_permits" ADD CONSTRAINT "unit_permits_decision"
  CHECK ("decision_source" IS NULL
      OR ("decision_source" = 'manager' AND "decided_by_account_id" IS NOT NULL)
      OR ("decision_source" = 'auto' AND "decided_by_account_id" IS NULL
          AND "kind" = 'event' AND "staff_note" IS NULL));
-- The status agrees with the times. status is NOT NULL.
ALTER TABLE "unit_permits" ADD CONSTRAINT "unit_permits_state_shape"
  CHECK (("decided_at" IS NULL) = ("decision_source" IS NULL)
     AND ("decided_by_account_id" IS NULL OR "decided_at" IS NOT NULL)
     AND ("staff_note" IS NULL OR "decided_at" IS NOT NULL)
     AND ("status" <> 'pending' OR ("decided_at" IS NULL AND "cancelled_at" IS NULL))
     AND ("status" = 'rejected') = ("reject_reason" IS NOT NULL)
     AND ("status" NOT IN ('approved', 'rejected', 'revoked', 'used') OR "decided_at" IS NOT NULL)
     AND ("status" = 'revoked') = ("revoked_at" IS NOT NULL)
     AND ("revoked_at" IS NULL) = ("revoked_by_account_id" IS NULL)
     AND ("revoked_at" IS NULL) = ("revoke_reason" IS NULL)
     AND ("revoke_note" IS NULL OR "revoked_at" IS NOT NULL)
     AND ("status" = 'used') = ("used_at" IS NOT NULL)
     AND ("used_at" IS NULL) = ("used_by_account_id" IS NULL)
     AND ("used_at" IS NULL) = ("used_gate_id" IS NULL)
     AND ("status" = 'cancelled') = ("cancelled_at" IS NOT NULL)
     AND ("cancelled_at" IS NULL) = ("cancel_side" IS NULL));

-- A permit keeps what it asks; it moves forward only and is decided, revoked,
-- used and cancelled once each. What the resident wrote and their photo go
-- once (their erasure); the plate and the photo once (the purge, 30 days
-- after the end). Never deleted.
CREATE FUNCTION unit_permit_moves_forward() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."number" = OLD."number"
     AND NEW."kind" = OLD."kind"
     AND NEW."unit_id" = OLD."unit_id"
     AND NEW."requested_by_account_id" = OLD."requested_by_account_id"
     AND NEW."starts_at" = OLD."starts_at"
     AND NEW."ends_at" = OLD."ends_at"
     AND NEW."created_at" = OLD."created_at"
     AND NEW."work_type" IS NOT DISTINCT FROM OLD."work_type"
     AND NEW."daily_from" IS NOT DISTINCT FROM OLD."daily_from"
     AND NEW."daily_to" IS NOT DISTINCT FROM OLD."daily_to"
     AND NEW."guest_limit" IS NOT DISTINCT FROM OLD."guest_limit"
     -- The resident's words stay, or go together, once.
     AND ((NEW."contractor_company" IS NOT DISTINCT FROM OLD."contractor_company"
           AND NEW."description" IS NOT DISTINCT FROM OLD."description"
           AND NEW."items_description" IS NOT DISTINCT FROM OLD."items_description"
           AND NEW."items" IS NOT DISTINCT FROM OLD."items"
           AND NEW."title" IS NOT DISTINCT FROM OLD."title"
           AND NEW."text_cleared_at" IS NOT DISTINCT FROM OLD."text_cleared_at")
          OR (OLD."text_cleared_at" IS NULL AND NEW."text_cleared_at" IS NOT NULL))
     -- The plate goes once, with the purge.
     AND ((NEW."truck_plate" IS NOT DISTINCT FROM OLD."truck_plate"
           AND NEW."purged_at" IS NOT DISTINCT FROM OLD."purged_at")
          OR (OLD."purged_at" IS NULL AND NEW."purged_at" IS NOT NULL))
     -- The photo goes with either, never comes back.
     AND (NEW."photo_file_id" IS NOT DISTINCT FROM OLD."photo_file_id"
          OR (NEW."photo_file_id" IS NULL
              AND ((OLD."text_cleared_at" IS NULL AND NEW."text_cleared_at" IS NOT NULL)
                   OR (OLD."purged_at" IS NULL AND NEW."purged_at" IS NOT NULL))))
     AND (NEW."status" = OLD."status"
          OR (OLD."status" = 'pending' AND NEW."status" IN ('approved', 'rejected', 'cancelled'))
          OR (OLD."status" = 'approved' AND NEW."status" IN ('cancelled', 'revoked', 'used')))
     AND ((NEW."decision_source" IS NOT DISTINCT FROM OLD."decision_source"
           AND NEW."decided_by_account_id" IS NOT DISTINCT FROM OLD."decided_by_account_id"
           AND NEW."decided_at" IS NOT DISTINCT FROM OLD."decided_at"
           AND NEW."reject_reason" IS NOT DISTINCT FROM OLD."reject_reason"
           AND NEW."staff_note" IS NOT DISTINCT FROM OLD."staff_note")
          OR OLD."decided_at" IS NULL)
     AND ((NEW."revoked_at" IS NOT DISTINCT FROM OLD."revoked_at"
           AND NEW."revoked_by_account_id" IS NOT DISTINCT FROM OLD."revoked_by_account_id"
           AND NEW."revoke_reason" IS NOT DISTINCT FROM OLD."revoke_reason"
           AND NEW."revoke_note" IS NOT DISTINCT FROM OLD."revoke_note")
          OR OLD."revoked_at" IS NULL)
     AND ((NEW."used_at" IS NOT DISTINCT FROM OLD."used_at"
           AND NEW."used_by_account_id" IS NOT DISTINCT FROM OLD."used_by_account_id"
           AND NEW."used_gate_id" IS NOT DISTINCT FROM OLD."used_gate_id")
          OR OLD."used_at" IS NULL)
     AND ((NEW."cancelled_at" IS NOT DISTINCT FROM OLD."cancelled_at"
           AND NEW."cancelled_by_account_id" IS NOT DISTINCT FROM OLD."cancelled_by_account_id"
           AND NEW."cancel_side" IS NOT DISTINCT FROM OLD."cancel_side"
           AND NEW."cancel_reason" IS NOT DISTINCT FROM OLD."cancel_reason")
          OR OLD."cancelled_at" IS NULL) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'unit_permits: a permit keeps what it asks, moves forward only and is never deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER unit_permits_move_forward
  BEFORE UPDATE OR DELETE ON "unit_permits"
  FOR EACH ROW EXECUTE FUNCTION unit_permit_moves_forward();
CREATE TRIGGER unit_permits_move_forward_truncate
  BEFORE TRUNCATE ON "unit_permits"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- A works permit's contractor workers: a name, a face and the type of the ID
-- they carry, and the last four characters of its number only as a keyed
-- hash (never the number, never a scan). Removed once, by the requester or
-- the management; purged once, 30 days after the permit ends.
-- ----------------------------------------------------------------------------
CREATE TABLE "permit_workers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "permit_id" UUID NOT NULL,
    -- Always 'works': the foreign key below points at a works permit only.
    "permit_kind" "unit_permit_kind" NOT NULL DEFAULT 'works',
    "full_name" TEXT,
    "photo_file_id" UUID,
    "id_type" "id_document_type" NOT NULL,
    "id_last4_hash" CHAR(64),
    "added_by_account_id" UUID NOT NULL,
    "removed_at" TIMESTAMPTZ(3),
    "removed_by_account_id" UUID,
    "removed_side" TEXT,
    "remove_reason" TEXT,
    "purged_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "permit_workers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "permit_workers_tenant_id_id_key"
  ON "permit_workers"("tenant_id", "id");
CREATE UNIQUE INDEX "permit_workers_photo_file_id_key"
  ON "permit_workers"("photo_file_id") WHERE "photo_file_id" IS NOT NULL;
CREATE INDEX "permit_workers_permit_idx"
  ON "permit_workers"("tenant_id", "permit_id", "created_at", "id");
ALTER TABLE "permit_workers"
  ADD CONSTRAINT "permit_workers_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "permit_workers_permit_fkey"
  FOREIGN KEY ("tenant_id", "permit_id", "permit_kind")
  REFERENCES "unit_permits"("tenant_id", "id", "kind")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "permit_workers_photo_fkey"
  FOREIGN KEY ("tenant_id", "photo_file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "permit_workers_added_by_fkey"
  FOREIGN KEY ("tenant_id", "added_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "permit_workers_removed_by_fkey"
  FOREIGN KEY ("tenant_id", "removed_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "permit_workers" ADD CONSTRAINT "permit_workers_kind"
  CHECK ("permit_kind" = 'works');
-- Who they are, until the purge takes all of it at once.
ALTER TABLE "permit_workers" ADD CONSTRAINT "permit_workers_purged"
  CHECK (("purged_at" IS NULL) = ("full_name" IS NOT NULL)
     AND ("purged_at" IS NULL) = ("photo_file_id" IS NOT NULL)
     AND ("purged_at" IS NULL) = ("id_last4_hash" IS NOT NULL));
ALTER TABLE "permit_workers" ADD CONSTRAINT "permit_workers_text"
  CHECK (("full_name" IS NULL OR char_length("full_name") BETWEEN 2 AND 120)
     AND ("id_last4_hash" IS NULL OR "id_last4_hash" ~ '^[0-9a-f]{64}$'));
-- REASON_CODES.permitWorkerRemove: the management says why; the requester
-- never has to.
ALTER TABLE "permit_workers" ADD CONSTRAINT "permit_workers_removal"
  CHECK (("removed_at" IS NULL) = ("removed_side" IS NULL)
     AND ("removed_at" IS NULL) = ("removed_by_account_id" IS NULL)
     AND ("removed_side" IS NULL
          OR ("removed_side" = 'requester' AND "remove_reason" IS NULL)
          OR ("removed_side" = 'management' AND "remove_reason" IS NOT NULL
              AND "remove_reason" IN ('misconduct', 'safety_concern', 'not_needed', 'other'))));

CREATE FUNCTION permit_worker_moves_forward() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."permit_id" = OLD."permit_id"
     AND NEW."permit_kind" = OLD."permit_kind"
     AND NEW."id_type" = OLD."id_type"
     AND NEW."added_by_account_id" = OLD."added_by_account_id"
     AND NEW."created_at" = OLD."created_at"
     AND ((NEW."removed_at" IS NOT DISTINCT FROM OLD."removed_at"
           AND NEW."removed_by_account_id" IS NOT DISTINCT FROM OLD."removed_by_account_id"
           AND NEW."removed_side" IS NOT DISTINCT FROM OLD."removed_side"
           AND NEW."remove_reason" IS NOT DISTINCT FROM OLD."remove_reason")
          OR OLD."removed_at" IS NULL)
     AND ((NEW."full_name" IS NOT DISTINCT FROM OLD."full_name"
           AND NEW."photo_file_id" IS NOT DISTINCT FROM OLD."photo_file_id"
           AND NEW."id_last4_hash" IS NOT DISTINCT FROM OLD."id_last4_hash"
           AND NEW."purged_at" IS NOT DISTINCT FROM OLD."purged_at")
          OR (OLD."purged_at" IS NULL AND NEW."purged_at" IS NOT NULL)) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'permit_workers: a worker keeps who they are until the purge, is removed once and is never deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER permit_workers_move_forward
  BEFORE UPDATE OR DELETE ON "permit_workers"
  FOR EACH ROW EXECUTE FUNCTION permit_worker_moves_forward();
CREATE TRIGGER permit_workers_move_forward_truncate
  BEFORE TRUNCATE ON "permit_workers"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- An event's guests: a name and, optionally, a car's plate. Removed once, by
-- the host; purged once, 30 days after the event ends.
-- ----------------------------------------------------------------------------
CREATE TABLE "permit_guests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "permit_id" UUID NOT NULL,
    -- Always 'event': the foreign key below points at an event only.
    "permit_kind" "unit_permit_kind" NOT NULL DEFAULT 'event',
    "full_name" TEXT,
    "vehicle_plate" TEXT,
    "plate_key" TEXT GENERATED ALWAYS AS (
      translate(replace("vehicle_plate", ' ', ''), '٠١٢٣٤٥٦٧٨٩أإآىة', '0123456789ااايه')
    ) STORED,
    "added_by_account_id" UUID NOT NULL,
    "removed_at" TIMESTAMPTZ(3),
    "purged_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "permit_guests_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "permit_guests_tenant_id_id_key"
  ON "permit_guests"("tenant_id", "id");
CREATE INDEX "permit_guests_permit_idx"
  ON "permit_guests"("tenant_id", "permit_id", "created_at", "id");
CREATE INDEX "permit_guests_plate_key_idx"
  ON "permit_guests"("tenant_id", "plate_key") WHERE "plate_key" IS NOT NULL;
ALTER TABLE "permit_guests"
  ADD CONSTRAINT "permit_guests_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "permit_guests_permit_fkey"
  FOREIGN KEY ("tenant_id", "permit_id", "permit_kind")
  REFERENCES "unit_permits"("tenant_id", "id", "kind")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "permit_guests_added_by_fkey"
  FOREIGN KEY ("tenant_id", "added_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "permit_guests" ADD CONSTRAINT "permit_guests_kind"
  CHECK ("permit_kind" = 'event');
ALTER TABLE "permit_guests" ADD CONSTRAINT "permit_guests_purged"
  CHECK (("purged_at" IS NULL) = ("full_name" IS NOT NULL)
     AND ("purged_at" IS NULL OR "vehicle_plate" IS NULL));
ALTER TABLE "permit_guests" ADD CONSTRAINT "permit_guests_text"
  CHECK (("full_name" IS NULL OR char_length("full_name") BETWEEN 2 AND 120)
     AND ("vehicle_plate" IS NULL OR char_length("vehicle_plate") BETWEEN 1 AND 12));

CREATE FUNCTION permit_guest_moves_forward() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."permit_id" = OLD."permit_id"
     AND NEW."permit_kind" = OLD."permit_kind"
     AND NEW."added_by_account_id" = OLD."added_by_account_id"
     AND NEW."created_at" = OLD."created_at"
     AND (NEW."removed_at" IS NOT DISTINCT FROM OLD."removed_at"
          OR OLD."removed_at" IS NULL)
     AND ((NEW."full_name" IS NOT DISTINCT FROM OLD."full_name"
           AND NEW."vehicle_plate" IS NOT DISTINCT FROM OLD."vehicle_plate"
           AND NEW."purged_at" IS NOT DISTINCT FROM OLD."purged_at")
          OR (OLD."purged_at" IS NULL AND NEW."purged_at" IS NOT NULL)) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'permit_guests: a guest keeps who they are until the purge, is removed once and is never deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER permit_guests_move_forward
  BEFORE UPDATE OR DELETE ON "permit_guests"
  FOR EACH ROW EXECUTE FUNCTION permit_guest_moves_forward();
CREATE TRIGGER permit_guests_move_forward_truncate
  BEFORE TRUNCATE ON "permit_guests"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "permit_counters", "unit_permits", "permit_workers", "permit_guests" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE
  ON "permit_counters", "unit_permits", "permit_workers", "permit_guests" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['permit_counters', 'unit_permits', 'permit_workers',
                           'permit_guests'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
