-- ============================================================================
-- Guard shifts and tasks (ADR 0050): swaps.
-- ============================================================================
--
-- A guard asks a colleague to take one of their slots: in exchange for one
-- of the colleague's (`colleague_slot_id`), or as a cover (none). The
-- colleague accepts or declines; the roster's keepers approve or reject an
-- accepted one, and approval gives the slots their new guards. A slot is in
-- one live swap at most (decided under the slots' locks; these indexes
-- back each side). Nothing is deleted.

CREATE TYPE "guard_swap_status" AS ENUM (
  'requested', 'accepted', 'approved', 'declined', 'rejected', 'withdrawn',
  'cancelled', 'expired'
);

CREATE TABLE "guard_shift_swaps" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "requester_account_id" UUID NOT NULL,
    "requester_slot_id" UUID NOT NULL,
    "colleague_account_id" UUID NOT NULL,
    "colleague_slot_id" UUID,
    -- The requester's words: never in the audit trail or a notification.
    "reason" TEXT,
    "reason_cleared_at" TIMESTAMPTZ(3),
    "status" "guard_swap_status" NOT NULL DEFAULT 'requested',
    "accepted_at" TIMESTAMPTZ(3),
    "decided_at" TIMESTAMPTZ(3),
    "decided_by_account_id" UUID,
    "reject_reason" TEXT,
    "closed_at" TIMESTAMPTZ(3),
    "close_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "guard_shift_swaps_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "guard_shift_swaps_tenant_id_id_key"
  ON "guard_shift_swaps"("tenant_id", "id");
CREATE UNIQUE INDEX "guard_shift_swaps_live_requester_slot_key"
  ON "guard_shift_swaps"("tenant_id", "requester_slot_id")
  WHERE "status" IN ('requested', 'accepted');
CREATE UNIQUE INDEX "guard_shift_swaps_live_colleague_slot_key"
  ON "guard_shift_swaps"("tenant_id", "colleague_slot_id")
  WHERE "status" IN ('requested', 'accepted') AND "colleague_slot_id" IS NOT NULL;
CREATE INDEX "guard_shift_swaps_requester_idx"
  ON "guard_shift_swaps"("tenant_id", "requester_account_id", "created_at");
CREATE INDEX "guard_shift_swaps_colleague_idx"
  ON "guard_shift_swaps"("tenant_id", "colleague_account_id", "created_at");
CREATE INDEX "guard_shift_swaps_status_idx"
  ON "guard_shift_swaps"("tenant_id", "status", "created_at", "id");

ALTER TABLE "guard_shift_swaps"
  ADD CONSTRAINT "guard_shift_swaps_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "guard_shift_swaps_tenant_id_requester_account_id_fkey"
    FOREIGN KEY ("tenant_id", "requester_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "guard_shift_swaps_tenant_id_requester_slot_id_fkey"
    FOREIGN KEY ("tenant_id", "requester_slot_id") REFERENCES "guard_roster_slots"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "guard_shift_swaps_tenant_id_colleague_account_id_fkey"
    FOREIGN KEY ("tenant_id", "colleague_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "guard_shift_swaps_tenant_id_colleague_slot_id_fkey"
    FOREIGN KEY ("tenant_id", "colleague_slot_id") REFERENCES "guard_roster_slots"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "guard_shift_swaps_tenant_id_decided_by_account_id_fkey"
    FOREIGN KEY ("tenant_id", "decided_by_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "guard_shift_swaps"
  ADD CONSTRAINT "guard_shift_swaps_not_self"
    CHECK ("colleague_account_id" <> "requester_account_id"),
  ADD CONSTRAINT "guard_shift_swaps_two_slots"
    CHECK ("colleague_slot_id" IS NULL OR "colleague_slot_id" <> "requester_slot_id"),
  ADD CONSTRAINT "guard_shift_swaps_reason_length"
    CHECK ("reason" IS NULL OR char_length("reason") BETWEEN 1 AND 500),
  ADD CONSTRAINT "guard_shift_swaps_cleared_shape"
    CHECK ("reason_cleared_at" IS NULL OR "reason" IS NULL),
  -- Accepted by the colleague before a decision; a decision names who and when.
  ADD CONSTRAINT "guard_shift_swaps_accepted_shape"
    CHECK (("status" IN ('accepted', 'approved', 'rejected')) <= ("accepted_at" IS NOT NULL)),
  ADD CONSTRAINT "guard_shift_swaps_decided_shape"
    CHECK (("status" IN ('approved', 'rejected')) = ("decided_at" IS NOT NULL)
           AND ("decided_at" IS NULL) = ("decided_by_account_id" IS NULL)
           AND ("status" = 'rejected') = ("reject_reason" IS NOT NULL)),
  -- REASON_CODES.guardSwapReject (src/core/common/reasons.ts); a unit test
  -- keeps them in step.
  ADD CONSTRAINT "guard_shift_swaps_reject_reason"
    CHECK ("reject_reason" IS NULL OR "reject_reason" IN ('staffing', 'too_late', 'other')),
  -- Ended without a decision: declined, withdrawn, cancelled, expired.
  ADD CONSTRAINT "guard_shift_swaps_closed_shape"
    CHECK (("status" IN ('declined', 'withdrawn', 'cancelled', 'expired')) = ("closed_at" IS NOT NULL)
           AND ("status" = 'cancelled') = ("close_reason" IS NOT NULL)),
  -- REASON_CODES.guardSwapCancel: what the system cancels one for.
  ADD CONSTRAINT "guard_shift_swaps_close_reason"
    CHECK ("close_reason" IS NULL OR "close_reason" IN ('slot_cancelled', 'slot_changed', 'guard_left'));

-- A swap keeps who asked whom for what; it moves forward only
-- (requested → accepted → approved | rejected; requested → declined; live →
-- withdrawn | cancelled | expired), and its reason goes once (its author's
-- erasure). Never deleted.
CREATE FUNCTION guard_shift_swap_moves_forward() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."requester_account_id" = OLD."requester_account_id"
     AND NEW."requester_slot_id" = OLD."requester_slot_id"
     AND NEW."colleague_account_id" = OLD."colleague_account_id"
     AND NEW."colleague_slot_id" IS NOT DISTINCT FROM OLD."colleague_slot_id"
     AND NEW."created_at" = OLD."created_at"
     AND ((NEW."reason" IS NOT DISTINCT FROM OLD."reason"
           AND NEW."reason_cleared_at" IS NOT DISTINCT FROM OLD."reason_cleared_at")
          OR (OLD."reason_cleared_at" IS NULL AND NEW."reason_cleared_at" IS NOT NULL
              AND NEW."reason" IS NULL))
     AND (NEW."status" = OLD."status"
          OR (OLD."status" = 'requested'
              AND NEW."status" IN ('accepted', 'declined', 'withdrawn', 'cancelled', 'expired'))
          OR (OLD."status" = 'accepted'
              AND NEW."status" IN ('approved', 'rejected', 'withdrawn', 'cancelled', 'expired')))
     AND (NEW."accepted_at" IS NOT DISTINCT FROM OLD."accepted_at" OR OLD."accepted_at" IS NULL)
     AND ((NEW."decided_at" IS NOT DISTINCT FROM OLD."decided_at"
           AND NEW."decided_by_account_id" IS NOT DISTINCT FROM OLD."decided_by_account_id"
           AND NEW."reject_reason" IS NOT DISTINCT FROM OLD."reject_reason")
          OR OLD."decided_at" IS NULL)
     AND ((NEW."closed_at" IS NOT DISTINCT FROM OLD."closed_at"
           AND NEW."close_reason" IS NOT DISTINCT FROM OLD."close_reason")
          OR OLD."closed_at" IS NULL) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'guard_shift_swaps: a swap keeps who asked whom for what, moves forward only and is never deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER guard_shift_swaps_move_forward
  BEFORE UPDATE OR DELETE ON "guard_shift_swaps"
  FOR EACH ROW EXECUTE FUNCTION guard_shift_swap_moves_forward();
CREATE TRIGGER guard_shift_swaps_move_forward_truncate
  BEFORE TRUNCATE ON "guard_shift_swaps"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "guard_shift_swaps" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "guard_shift_swaps" TO jiwar_app;
ALTER TABLE "guard_shift_swaps" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "guard_shift_swaps" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "guard_shift_swaps"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
