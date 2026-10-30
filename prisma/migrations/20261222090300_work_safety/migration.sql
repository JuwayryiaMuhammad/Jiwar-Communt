-- ============================================================================
-- Field safety (ADR 0067): the hazards a ticket category or an asset type
-- needs a work permit for; a technician's work permit on a ticket's cycle,
-- decided once by `safety.manage`, revoked once, closed when the work is
-- done; a category's safety instructions in versions, and the technician's
-- acknowledgement of one for a ticket, with the hash of what was shown.
-- The work starts only with an approved permit, not expired, for every
-- hazard it needs, and the category's current instructions acknowledged —
-- checked under the ticket's lock, which every permit write takes first.
-- Nothing here is deleted.
-- ============================================================================

-- REASON_CODES.workHazard; a unit test keeps the lists in step.
ALTER TABLE "ticket_categories"
  ADD COLUMN "requires_permit" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "ticket_categories" ADD CONSTRAINT "ticket_categories_requires_permit_known"
  CHECK ("requires_permit" <@ ARRAY['hot_work', 'height', 'live_electrical', 'confined_space', 'pool_chemicals']::text[]);
ALTER TABLE "asset_types"
  ADD COLUMN "requires_permit" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "asset_types" ADD CONSTRAINT "asset_types_requires_permit_known"
  CHECK ("requires_permit" <@ ARRAY['hot_work', 'height', 'live_electrical', 'confined_space', 'pool_chemicals']::text[]);

-- ----------------------------------------------------------------------------
-- Work permits.
-- ----------------------------------------------------------------------------
CREATE TABLE "work_permits" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "cycle" INTEGER NOT NULL,
    "hazard" TEXT NOT NULL,
    "precautions" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "requested_by_account_id" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by_account_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "reject_reason" TEXT,
    "revoked_by_account_id" UUID,
    "revoked_at" TIMESTAMPTZ(3),
    "revoke_reason" TEXT,
    "closed_at" TIMESTAMPTZ(3),
    CONSTRAINT "work_permits_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "work_permits_tenant_id_id_key" ON "work_permits"("tenant_id", "id");
-- One open permit (requested or approved) per ticket, cycle and hazard.
CREATE UNIQUE INDEX "work_permits_open_key"
  ON "work_permits"("tenant_id", "ticket_id", "cycle", "hazard")
  WHERE "status" IN ('requested', 'approved');
CREATE INDEX "work_permits_ticket_idx"
  ON "work_permits"("tenant_id", "ticket_id", "cycle", "requested_at", "id");
CREATE INDEX "work_permits_list_idx"
  ON "work_permits"("tenant_id", "requested_at", "id");
ALTER TABLE "work_permits"
  ADD CONSTRAINT "work_permits_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "work_permits_ticket_fkey"
    FOREIGN KEY ("tenant_id", "ticket_id") REFERENCES "tickets"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "work_permits_requested_by_fkey"
    FOREIGN KEY ("tenant_id", "requested_by_account_id") REFERENCES "accounts"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "work_permits_decided_by_fkey"
    FOREIGN KEY ("tenant_id", "decided_by_account_id") REFERENCES "accounts"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "work_permits_revoked_by_fkey"
    FOREIGN KEY ("tenant_id", "revoked_by_account_id") REFERENCES "accounts"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "work_permits"
  ADD CONSTRAINT "work_permits_hazard_known"
    CHECK ("hazard" IN ('hot_work', 'height', 'live_electrical', 'confined_space', 'pool_chemicals')),
  ADD CONSTRAINT "work_permits_precautions_length"
    CHECK (char_length("precautions") BETWEEN 1 AND 2000),
  ADD CONSTRAINT "work_permits_cycle_range"
    CHECK ("cycle" >= 1),
  -- A day at most: a permit is for today's work.
  ADD CONSTRAINT "work_permits_window"
    CHECK ("expires_at" > "requested_at" AND "expires_at" <= "requested_at" + interval '24 hours'),
  ADD CONSTRAINT "work_permits_status_known"
    CHECK ("status" IN ('requested', 'approved', 'rejected', 'revoked', 'closed')),
  ADD CONSTRAINT "work_permits_reject_reason_known"
    CHECK ("reject_reason" IS NULL
        OR "reject_reason" IN ('precautions_insufficient', 'not_qualified', 'wrong_hazard', 'not_needed', 'other')),
  ADD CONSTRAINT "work_permits_revoke_reason_known"
    CHECK ("revoke_reason" IS NULL
        OR "revoke_reason" IN ('unsafe_conditions', 'precautions_not_followed', 'scope_changed', 'other')),
  -- Each status has exactly its own fields. A closed permit was requested
  -- or approved when the work was done.
  ADD CONSTRAINT "work_permits_state_shape"
    CHECK (CASE "status"
      WHEN 'requested' THEN "decided_at" IS NULL AND "decided_by_account_id" IS NULL
        AND "reject_reason" IS NULL AND "revoked_at" IS NULL AND "revoked_by_account_id" IS NULL
        AND "revoke_reason" IS NULL AND "closed_at" IS NULL
      WHEN 'approved' THEN "decided_at" IS NOT NULL AND "decided_by_account_id" IS NOT NULL
        AND "reject_reason" IS NULL AND "revoked_at" IS NULL AND "revoked_by_account_id" IS NULL
        AND "revoke_reason" IS NULL AND "closed_at" IS NULL
      WHEN 'rejected' THEN "decided_at" IS NOT NULL AND "decided_by_account_id" IS NOT NULL
        AND "reject_reason" IS NOT NULL AND "revoked_at" IS NULL AND "revoked_by_account_id" IS NULL
        AND "revoke_reason" IS NULL AND "closed_at" IS NULL
      WHEN 'revoked' THEN "decided_at" IS NOT NULL AND "decided_by_account_id" IS NOT NULL
        AND "reject_reason" IS NULL AND "revoked_at" IS NOT NULL AND "revoked_by_account_id" IS NOT NULL
        AND "revoke_reason" IS NOT NULL AND "closed_at" IS NULL
      WHEN 'closed' THEN "reject_reason" IS NULL AND "revoked_at" IS NULL
        AND "revoked_by_account_id" IS NULL AND "revoke_reason" IS NULL AND "closed_at" IS NOT NULL
        AND ("decided_at" IS NULL) = ("decided_by_account_id" IS NULL)
      ELSE false END);

-- The terms are fixed; a permit moves forward only — requested to approved,
-- rejected or closed, approved to revoked or closed — and once it is
-- rejected, revoked or closed it never changes.
CREATE FUNCTION work_permit_moves_forward() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."ticket_id" = OLD."ticket_id"
     AND NEW."cycle" = OLD."cycle"
     AND NEW."hazard" = OLD."hazard"
     AND NEW."precautions" = OLD."precautions"
     AND NEW."expires_at" = OLD."expires_at"
     AND NEW."requested_by_account_id" = OLD."requested_by_account_id"
     AND NEW."requested_at" = OLD."requested_at"
     AND (NEW."status" = OLD."status"
          OR (OLD."status" = 'requested' AND NEW."status" IN ('approved', 'rejected', 'closed'))
          OR (OLD."status" = 'approved' AND NEW."status" IN ('revoked', 'closed')))
     AND (OLD."status" = 'requested' OR (
          NEW."decided_at" IS NOT DISTINCT FROM OLD."decided_at"
      AND NEW."decided_by_account_id" IS NOT DISTINCT FROM OLD."decided_by_account_id"
      AND NEW."reject_reason" IS NOT DISTINCT FROM OLD."reject_reason"))
     AND (OLD."status" IN ('requested', 'approved') OR (
          NEW."status" = OLD."status"
      AND NEW."revoked_at" IS NOT DISTINCT FROM OLD."revoked_at"
      AND NEW."revoked_by_account_id" IS NOT DISTINCT FROM OLD."revoked_by_account_id"
      AND NEW."revoke_reason" IS NOT DISTINCT FROM OLD."revoke_reason"
      AND NEW."closed_at" IS NOT DISTINCT FROM OLD."closed_at")) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'work_permits: a permit keeps its terms and moves forward once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER work_permits_move_forward
  BEFORE UPDATE OR DELETE ON "work_permits"
  FOR EACH ROW EXECUTE FUNCTION work_permit_moves_forward();
CREATE TRIGGER work_permits_move_forward_truncate
  BEFORE TRUNCATE ON "work_permits"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Safety instructions, a version per change, and their acknowledgements.
-- ----------------------------------------------------------------------------
CREATE TABLE "safety_instructions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "text_en" TEXT NOT NULL,
    "text_ar" TEXT NOT NULL,
    "created_by_account_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "safety_instructions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "safety_instructions_tenant_id_id_key" ON "safety_instructions"("tenant_id", "id");
CREATE UNIQUE INDEX "safety_instructions_version_key"
  ON "safety_instructions"("tenant_id", "category_id", "version");
ALTER TABLE "safety_instructions"
  ADD CONSTRAINT "safety_instructions_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "safety_instructions_category_fkey"
    FOREIGN KEY ("tenant_id", "category_id") REFERENCES "ticket_categories"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "safety_instructions_created_by_fkey"
    FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "safety_instructions"
  ADD CONSTRAINT "safety_instructions_version_range" CHECK ("version" >= 1),
  ADD CONSTRAINT "safety_instructions_text_length"
    CHECK (char_length("text_en") BETWEEN 1 AND 4000 AND char_length("text_ar") BETWEEN 1 AND 4000);

CREATE TABLE "safety_acknowledgements" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "instruction_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "cycle" INTEGER NOT NULL,
    "content_sha256" CHAR(64) NOT NULL,
    "acknowledged_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "safety_acknowledgements_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "safety_acknowledgements_tenant_id_id_key" ON "safety_acknowledgements"("tenant_id", "id");
-- Once per instruction version, technician, ticket and cycle.
CREATE UNIQUE INDEX "safety_acknowledgements_once_key"
  ON "safety_acknowledgements"("tenant_id", "instruction_id", "account_id", "ticket_id", "cycle");
ALTER TABLE "safety_acknowledgements"
  ADD CONSTRAINT "safety_acknowledgements_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "safety_acknowledgements_instruction_fkey"
    FOREIGN KEY ("tenant_id", "instruction_id") REFERENCES "safety_instructions"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "safety_acknowledgements_account_fkey"
    FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "safety_acknowledgements_ticket_fkey"
    FOREIGN KEY ("tenant_id", "ticket_id") REFERENCES "tickets"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "safety_acknowledgements"
  ADD CONSTRAINT "safety_acknowledgements_sha_shape" CHECK ("content_sha256" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "safety_acknowledgements_cycle_range" CHECK ("cycle" >= 1);

CREATE TRIGGER safety_instructions_immutable
  BEFORE UPDATE OR DELETE ON "safety_instructions"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER safety_instructions_immutable_truncate
  BEFORE TRUNCATE ON "safety_instructions"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER safety_acknowledgements_immutable
  BEFORE UPDATE OR DELETE ON "safety_acknowledgements"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER safety_acknowledgements_immutable_truncate
  BEFORE TRUNCATE ON "safety_acknowledgements"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Grants: a permit changes in place under FOR UPDATE (after its ticket's
-- lock) and a start reads it FOR SHARE; instructions and acknowledgements
-- are added, then only read. RLS, FORCE.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "work_permits", "safety_instructions", "safety_acknowledgements" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "work_permits" TO jiwar_app;
GRANT SELECT, INSERT ON "safety_instructions", "safety_acknowledgements" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['work_permits', 'safety_instructions', 'safety_acknowledgements'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
