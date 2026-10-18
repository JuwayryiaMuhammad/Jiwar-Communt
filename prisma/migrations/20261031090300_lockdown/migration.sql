-- ============================================================================
-- Security (ADR 0053): the lockdown of the gates.
--
-- * `gate_lockdown_states`: one row per compound, the row every lockdown
--   decision takes. A start and an end take it FOR UPDATE; a verify, an
--   entry in, a gate request and a material entry take it FOR SHARE. So a
--   start waits for the entries in flight and every later one sees it.
--   The row is never changed: it is only locked (FOR SHARE and FOR UPDATE
--   need UPDATE on the table; a trigger refuses any real UPDATE or DELETE).
-- * `gate_lockdowns`: one gate, or all (`gate_id` NULL). One live per scope:
--   checked under the state row, with a partial unique index NULLS NOT
--   DISTINCT behind it (the "all" lockdown included). Started once, ended
--   once by the management, never deleted.
-- * `gate_lockdown_overrides`: an emergency vehicle a guard let through a
--   locked gate, with its code. Append-only.
-- ============================================================================

CREATE TABLE "gate_lockdown_states" (
    "tenant_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "gate_lockdown_states_pkey" PRIMARY KEY ("tenant_id")
);
ALTER TABLE "gate_lockdown_states" ADD CONSTRAINT "gate_lockdown_states_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION gate_lockdown_state_is_a_lock() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'gate_lockdown_states: the row is only locked, never changed or deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER gate_lockdown_states_only_locked
  BEFORE UPDATE OR DELETE ON "gate_lockdown_states"
  FOR EACH ROW EXECUTE FUNCTION gate_lockdown_state_is_a_lock();
CREATE TRIGGER gate_lockdown_states_only_locked_truncate
  BEFORE TRUNCATE ON "gate_lockdown_states"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
CREATE TABLE "gate_lockdowns" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    -- NULL: every gate of the compound.
    "gate_id" UUID,
    "reason_code" TEXT NOT NULL,
    "started_by_account_id" UUID NOT NULL,
    "started_shift_id" UUID NOT NULL,
    -- The database's clock after the state row's lock.
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "ended_at" TIMESTAMPTZ(3),
    "ended_by_account_id" UUID,
    "end_reason" TEXT,
    -- The manager's words on ending it: the management's only.
    "end_note" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "gate_lockdowns_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "gate_lockdowns_tenant_id_id_key" ON "gate_lockdowns"("tenant_id", "id");
-- One live lockdown per scope; the "all" one (gate_id NULL) too.
CREATE UNIQUE INDEX "gate_lockdowns_one_live"
  ON "gate_lockdowns"("tenant_id", "gate_id") NULLS NOT DISTINCT
  WHERE "ended_at" IS NULL;
CREATE INDEX "gate_lockdowns_started_idx"
  ON "gate_lockdowns"("tenant_id", "started_at", "id");
ALTER TABLE "gate_lockdowns"
  ADD CONSTRAINT "gate_lockdowns_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_lockdowns_tenant_id_gate_id_fkey"
  FOREIGN KEY ("tenant_id", "gate_id") REFERENCES "gates"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_lockdowns_tenant_id_started_by_fkey"
  FOREIGN KEY ("tenant_id", "started_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_lockdowns_tenant_id_started_shift_fkey"
  FOREIGN KEY ("tenant_id", "started_shift_id") REFERENCES "guard_shifts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_lockdowns_tenant_id_ended_by_fkey"
  FOREIGN KEY ("tenant_id", "ended_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- REASON_CODES.gateLockdownStart and gateLockdownEnd; a unit test keeps
-- them in step.
ALTER TABLE "gate_lockdowns" ADD CONSTRAINT "gate_lockdowns_reason"
  CHECK ("reason_code" IN ('security_threat', 'intruder', 'violence', 'fire', 'police_request', 'drill', 'other'));
-- Ended: when, by whom and why, together; a note only on an end.
ALTER TABLE "gate_lockdowns" ADD CONSTRAINT "gate_lockdowns_end_shape"
  CHECK (("ended_at" IS NULL) = ("ended_by_account_id" IS NULL)
     AND ("ended_at" IS NULL) = ("end_reason" IS NULL)
     AND ("end_note" IS NULL OR "ended_at" IS NOT NULL)
     AND ("ended_at" IS NULL OR "ended_at" >= "started_at"));
ALTER TABLE "gate_lockdowns" ADD CONSTRAINT "gate_lockdowns_end_reason"
  CHECK ("end_reason" IS NULL
      OR "end_reason" IN ('threat_cleared', 'false_alarm', 'drill_over', 'other'));
ALTER TABLE "gate_lockdowns" ADD CONSTRAINT "gate_lockdowns_end_note_length"
  CHECK ("end_note" IS NULL OR char_length("end_note") BETWEEN 1 AND 500);

-- A lockdown is started once and ended once; what started it never
-- changes; an ended one never changes again. Never deleted.
CREATE FUNCTION gate_lockdown_moves_forward() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."gate_id" IS NOT DISTINCT FROM OLD."gate_id"
     AND NEW."reason_code" = OLD."reason_code"
     AND NEW."started_by_account_id" = OLD."started_by_account_id"
     AND NEW."started_shift_id" = OLD."started_shift_id"
     AND NEW."started_at" = OLD."started_at"
     AND OLD."ended_at" IS NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'gate_lockdowns: a lockdown is ended once and never deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER gate_lockdowns_move_forward
  BEFORE UPDATE OR DELETE ON "gate_lockdowns"
  FOR EACH ROW EXECUTE FUNCTION gate_lockdown_moves_forward();
CREATE TRIGGER gate_lockdowns_move_forward_truncate
  BEFORE TRUNCATE ON "gate_lockdowns"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
CREATE TABLE "gate_lockdown_overrides" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "lockdown_id" UUID NOT NULL,
    "gate_id" UUID NOT NULL,
    "shift_id" UUID NOT NULL,
    "guard_account_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "emergency_id" UUID,
    "gate_service_request_id" UUID,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "gate_lockdown_overrides_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "gate_lockdown_overrides_tenant_id_id_key" ON "gate_lockdown_overrides"("tenant_id", "id");
CREATE INDEX "gate_lockdown_overrides_lockdown_idx"
  ON "gate_lockdown_overrides"("tenant_id", "lockdown_id", "occurred_at", "id");
ALTER TABLE "gate_lockdown_overrides"
  ADD CONSTRAINT "gate_lockdown_overrides_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_lockdown_overrides_tenant_id_lockdown_fkey"
  FOREIGN KEY ("tenant_id", "lockdown_id") REFERENCES "gate_lockdowns"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_lockdown_overrides_tenant_id_gate_fkey"
  FOREIGN KEY ("tenant_id", "gate_id") REFERENCES "gates"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_lockdown_overrides_tenant_id_shift_fkey"
  FOREIGN KEY ("tenant_id", "shift_id") REFERENCES "guard_shifts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_lockdown_overrides_tenant_id_guard_fkey"
  FOREIGN KEY ("tenant_id", "guard_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_lockdown_overrides_tenant_id_emergency_fkey"
  FOREIGN KEY ("tenant_id", "emergency_id") REFERENCES "emergencies"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_lockdown_overrides_tenant_id_request_fkey"
  FOREIGN KEY ("tenant_id", "gate_service_request_id") REFERENCES "gate_service_requests"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- REASON_CODES.gateLockdownOverride; a unit test keeps them in step.
ALTER TABLE "gate_lockdown_overrides" ADD CONSTRAINT "gate_lockdown_overrides_kind"
  CHECK ("kind" IN ('ambulance', 'fire_truck', 'police', 'civil_defense'));
CREATE TRIGGER gate_lockdown_overrides_immutable_rows
  BEFORE UPDATE OR DELETE ON "gate_lockdown_overrides"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER gate_lockdown_overrides_immutable_truncate
  BEFORE TRUNCATE ON "gate_lockdown_overrides"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
REVOKE ALL ON "gate_lockdown_states", "gate_lockdowns", "gate_lockdown_overrides" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "gate_lockdown_states" TO jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "gate_lockdowns" TO jiwar_app;
GRANT SELECT, INSERT ON "gate_lockdown_overrides" TO jiwar_app;
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['gate_lockdown_states', 'gate_lockdowns', 'gate_lockdown_overrides'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- Existing compounds get what a new one gets (src/gate/lockdown/
-- lockdown-provisioning.ts): the state row. FORCE RLS applies here too: one
-- compound at a time.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', t."id"::text, true);
    INSERT INTO "gate_lockdown_states" ("tenant_id") VALUES (t."id");
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
