-- ============================================================================
-- Corrective actions (ADR 0087): what an incident's investigation decides
-- must be done, each with its owner (an active staff member or the
-- manager), its due day and its state. An incident is not closed while one
-- of its actions is open (the service refuses, INCIDENT_ACTIONS_OPEN): a
-- close takes the incident FOR UPDATE and counts them; a new action takes it
-- FOR SHARE, refused once it is closed.
--
-- Done once (with a note of the doer's own) or called off once (a code),
-- never both. What the account wrote — the description, the done note —
-- goes when it is erased (ADR 0053's rule), once; nothing else changes then.
-- ============================================================================

CREATE TABLE "incident_actions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "incident_id" UUID NOT NULL,
    -- NULL only once an erasure cleared it.
    "description" TEXT,
    "owner_account_id" UUID NOT NULL,
    "due_on" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "done_at" TIMESTAMPTZ(3),
    "done_by_account_id" UUID,
    "done_note" TEXT,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by_account_id" UUID,
    "cancel_reason" TEXT,
    "overdue_notified_at" TIMESTAMPTZ(3),
    "text_cleared_at" TIMESTAMPTZ(3),
    "created_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "incident_actions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "incident_actions_tenant_id_id_key" ON "incident_actions"("tenant_id", "id");
CREATE INDEX "incident_actions_incident_idx"
  ON "incident_actions"("tenant_id", "incident_id", "created_at", "id");
-- An owner's open actions, by due day.
CREATE INDEX "incident_actions_owner_idx"
  ON "incident_actions"("tenant_id", "owner_account_id", "due_on", "id")
  WHERE "status" = 'open';
-- What the overdue sweep reads: open actions not yet told about.
CREATE INDEX "incident_actions_overdue_idx"
  ON "incident_actions"("tenant_id", "due_on", "id")
  WHERE "status" = 'open' AND "overdue_notified_at" IS NULL;
ALTER TABLE "incident_actions"
  ADD CONSTRAINT "incident_actions_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "incident_actions_tenant_id_incident_fkey"
  FOREIGN KEY ("tenant_id", "incident_id") REFERENCES "incidents"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "incident_actions_tenant_id_owner_fkey"
  FOREIGN KEY ("tenant_id", "owner_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "incident_actions_tenant_id_done_by_fkey"
  FOREIGN KEY ("tenant_id", "done_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "incident_actions_tenant_id_cancelled_by_fkey"
  FOREIGN KEY ("tenant_id", "cancelled_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "incident_actions_tenant_id_created_by_fkey"
  FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "incident_actions" ADD CONSTRAINT "incident_actions_status_known"
  CHECK ("status" IN ('open', 'done', 'cancelled'));
-- A description of 1 to 1000 characters until an erasure clears it; a done
-- note of the same, only on a done one.
ALTER TABLE "incident_actions" ADD CONSTRAINT "incident_actions_text_length"
  CHECK (("description" IS NOT NULL OR "text_cleared_at" IS NOT NULL)
     AND ("description" IS NULL OR char_length("description") BETWEEN 1 AND 1000)
     AND ("done_note" IS NULL OR char_length("done_note") BETWEEN 1 AND 1000));
-- Done with its time and doer, called off with its time, its canceller and
-- a code from REASON_CODES.incidentActionCancel; never both.
ALTER TABLE "incident_actions" ADD CONSTRAINT "incident_actions_state_shape"
  CHECK (("status" = 'done') = ("done_at" IS NOT NULL)
     AND ("done_at" IS NULL) = ("done_by_account_id" IS NULL)
     AND ("done_note" IS NULL OR "done_at" IS NOT NULL)
     AND ("status" = 'cancelled') = ("cancelled_at" IS NOT NULL)
     AND ("cancelled_at" IS NULL) = ("cancelled_by_account_id" IS NULL)
     AND ("cancelled_at" IS NULL) = ("cancel_reason" IS NULL)
     AND ("cancel_reason" IS NULL
          OR "cancel_reason" IN ('not_needed', 'duplicate', 'superseded', 'other')));

-- An action keeps its incident, who made it and when; while open its
-- words, owner, day and the sweep's mark change; done or called off once,
-- it changes no more, but for an erasure clearing what the account wrote.
-- Never deleted.
CREATE FUNCTION incident_actions_end_once() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."incident_id" = OLD."incident_id"
     AND NEW."created_by_account_id" = OLD."created_by_account_id"
     AND NEW."created_at" = OLD."created_at"
     AND (OLD."status" = 'open'
          OR (NEW."status" = OLD."status"
              AND NEW."owner_account_id" = OLD."owner_account_id"
              AND NEW."due_on" = OLD."due_on"
              AND NEW."done_at" IS NOT DISTINCT FROM OLD."done_at"
              AND NEW."done_by_account_id" IS NOT DISTINCT FROM OLD."done_by_account_id"
              AND NEW."cancelled_at" IS NOT DISTINCT FROM OLD."cancelled_at"
              AND NEW."cancelled_by_account_id" IS NOT DISTINCT FROM OLD."cancelled_by_account_id"
              AND NEW."cancel_reason" IS NOT DISTINCT FROM OLD."cancel_reason"
              AND NEW."overdue_notified_at" IS NOT DISTINCT FROM OLD."overdue_notified_at"
              AND (NEW."description" IS NOT DISTINCT FROM OLD."description" OR NEW."description" IS NULL)
              AND (NEW."done_note" IS NOT DISTINCT FROM OLD."done_note" OR NEW."done_note" IS NULL))) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'incident_actions: an action is done or called off once and never deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER incident_actions_end_once
  BEFORE UPDATE OR DELETE ON "incident_actions"
  FOR EACH ROW EXECUTE FUNCTION incident_actions_end_once();
CREATE TRIGGER incident_actions_end_once_truncate
  BEFORE TRUNCATE ON "incident_actions"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Grants: it changes in place under FOR UPDATE, after its incident. RLS,
-- FORCE.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "incident_actions" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "incident_actions" TO jiwar_app;

ALTER TABLE "incident_actions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "incident_actions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "incident_actions"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
