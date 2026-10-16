-- ============================================================================
-- Guard shifts and tasks (ADR 0050): the handover.
-- ============================================================================
--
-- A guard who ends their shift ticks the compound's checklist (items the
-- management keeps) and may leave notes; the next guard at that post
-- acknowledges it. A shift the system ends (its post out of service, its
-- guard gone) leaves a handover with no checklist. Nothing is deleted.

CREATE TYPE "guard_handover_kind" AS ENUM ('guard', 'system');

-- ----------------------------------------------------------------------------
-- The checklist: retired, never deleted.
-- ----------------------------------------------------------------------------
CREATE TABLE "guard_handover_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "guard_handover_items_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "guard_handover_items_tenant_id_id_key"
  ON "guard_handover_items"("tenant_id", "id");
CREATE INDEX "guard_handover_items_order_idx"
  ON "guard_handover_items"("tenant_id", "position", "id");
ALTER TABLE "guard_handover_items"
  ADD CONSTRAINT "guard_handover_items_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "guard_handover_items_label_length"
    CHECK (char_length("label") BETWEEN 1 AND 120),
  ADD CONSTRAINT "guard_handover_items_position_range"
    CHECK ("position" BETWEEN 0 AND 1000);
CREATE FUNCTION guard_handover_item_is_kept() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'guard_handover_items: an item is retired, never deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER guard_handover_items_kept
  BEFORE DELETE ON "guard_handover_items"
  FOR EACH ROW EXECUTE FUNCTION guard_handover_item_is_kept();
CREATE TRIGGER guard_handover_items_kept_truncate
  BEFORE TRUNCATE ON "guard_handover_items"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Handovers: one per ended shift.
-- ----------------------------------------------------------------------------
CREATE TABLE "guard_handovers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "shift_id" UUID NOT NULL,
    "guard_account_id" UUID NOT NULL,
    "gate_id" UUID,
    "place_id" UUID,
    "kind" "guard_handover_kind" NOT NULL,
    -- What the guard ticked, as the items read then: [{"itemId", "label"}].
    "checklist" JSONB NOT NULL DEFAULT '[]',
    "notes" TEXT,
    "notes_cleared_at" TIMESTAMPTZ(3),
    "acknowledged_by_account_id" UUID,
    "acknowledged_shift_id" UUID,
    "acknowledged_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guard_handovers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "guard_handovers_tenant_id_id_key"
  ON "guard_handovers"("tenant_id", "id");
CREATE UNIQUE INDEX "guard_handovers_shift_key"
  ON "guard_handovers"("tenant_id", "shift_id");
-- What the next guard at a post is shown.
CREATE INDEX "guard_handovers_pending_gate_idx"
  ON "guard_handovers"("tenant_id", "gate_id", "created_at")
  WHERE "acknowledged_at" IS NULL;
CREATE INDEX "guard_handovers_pending_place_idx"
  ON "guard_handovers"("tenant_id", "place_id", "created_at")
  WHERE "acknowledged_at" IS NULL;
CREATE INDEX "guard_handovers_created_idx"
  ON "guard_handovers"("tenant_id", "created_at", "id");
CREATE INDEX "guard_handovers_guard_idx"
  ON "guard_handovers"("tenant_id", "guard_account_id");

ALTER TABLE "guard_handovers"
  ADD CONSTRAINT "guard_handovers_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "guard_handovers_tenant_id_shift_id_fkey"
    FOREIGN KEY ("tenant_id", "shift_id") REFERENCES "guard_shifts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "guard_handovers_tenant_id_guard_account_id_fkey"
    FOREIGN KEY ("tenant_id", "guard_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "guard_handovers_tenant_id_gate_id_fkey"
    FOREIGN KEY ("tenant_id", "gate_id") REFERENCES "gates"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "guard_handovers_tenant_id_place_id_fkey"
    FOREIGN KEY ("tenant_id", "place_id") REFERENCES "places"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "guard_handovers_tenant_id_acknowledged_by_account_id_fkey"
    FOREIGN KEY ("tenant_id", "acknowledged_by_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "guard_handovers_tenant_id_acknowledged_shift_id_fkey"
    FOREIGN KEY ("tenant_id", "acknowledged_shift_id") REFERENCES "guard_shifts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "guard_handovers"
  ADD CONSTRAINT "guard_handovers_one_post"
    CHECK (num_nonnulls("gate_id", "place_id") = 1),
  ADD CONSTRAINT "guard_handovers_checklist_shape"
    CHECK (jsonb_typeof("checklist") = 'array'),
  -- The system's handover has nothing the guard would write.
  ADD CONSTRAINT "guard_handovers_system_shape"
    CHECK ("kind" = 'guard' OR ("notes" IS NULL AND "checklist" = '[]')),
  ADD CONSTRAINT "guard_handovers_notes_length"
    CHECK ("notes" IS NULL OR char_length("notes") BETWEEN 1 AND 2000),
  ADD CONSTRAINT "guard_handovers_cleared_shape"
    CHECK ("notes_cleared_at" IS NULL OR "notes" IS NULL),
  ADD CONSTRAINT "guard_handovers_ack_is_complete"
    CHECK (num_nonnulls("acknowledged_by_account_id", "acknowledged_shift_id", "acknowledged_at") IN (0, 3)),
  ADD CONSTRAINT "guard_handovers_not_own"
    CHECK ("acknowledged_by_account_id" IS NULL OR "acknowledged_by_account_id" <> "guard_account_id");

-- A handover says what it said; it is acknowledged once, and its notes go
-- once (their author's erasure). Never deleted.
CREATE FUNCTION guard_handover_is_kept() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."shift_id" = OLD."shift_id"
     AND NEW."guard_account_id" = OLD."guard_account_id"
     AND NEW."gate_id" IS NOT DISTINCT FROM OLD."gate_id"
     AND NEW."place_id" IS NOT DISTINCT FROM OLD."place_id"
     AND NEW."kind" = OLD."kind"
     AND NEW."checklist" = OLD."checklist"
     AND NEW."created_at" = OLD."created_at"
     AND ((NEW."notes" IS NOT DISTINCT FROM OLD."notes"
           AND NEW."notes_cleared_at" IS NOT DISTINCT FROM OLD."notes_cleared_at")
          OR (OLD."notes_cleared_at" IS NULL AND NEW."notes_cleared_at" IS NOT NULL
              AND NEW."notes" IS NULL))
     AND ((NEW."acknowledged_by_account_id" IS NOT DISTINCT FROM OLD."acknowledged_by_account_id"
           AND NEW."acknowledged_shift_id" IS NOT DISTINCT FROM OLD."acknowledged_shift_id"
           AND NEW."acknowledged_at" IS NOT DISTINCT FROM OLD."acknowledged_at")
          OR OLD."acknowledged_at" IS NULL) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'guard_handovers: a handover keeps what it said, is acknowledged once and is never deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER guard_handovers_kept
  BEFORE UPDATE OR DELETE ON "guard_handovers"
  FOR EACH ROW EXECUTE FUNCTION guard_handover_is_kept();
CREATE TRIGGER guard_handovers_kept_truncate
  BEFORE TRUNCATE ON "guard_handovers"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Privileges and RLS.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "guard_handover_items", "guard_handovers" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "guard_handover_items", "guard_handovers" TO jiwar_app;

ALTER TABLE "guard_handover_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "guard_handover_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "guard_handover_items"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "guard_handovers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "guard_handovers" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "guard_handovers"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
