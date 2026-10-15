-- ============================================================================
-- Emergencies and gate services (ADR 0047): emergencies.
--
-- A resident reports a medical, fire, security or facilities emergency from
-- a unit. Every guard on an open shift and every holder of
-- `emergencies.respond` is told at once (a critical push); the others who
-- live in the unit are told too, and may answer "on my way". A responder
-- accepts with the minutes they expect to take, arrives, and resolves it;
-- the reporter or the unit's primary may cancel it while it is open. Nobody
-- accepting within two minutes escalates it to the management, once.
--
-- One open emergency per unit and type: a second report returns the first.
-- Nothing a person wrote is kept here but a staff's closing note; the rows
-- hold ids, codes and times, and are never deleted.
-- ============================================================================

CREATE TYPE "safety_counter_series" AS ENUM ('emergency', 'accessibility', 'service');
CREATE TYPE "emergency_type" AS ENUM ('medical', 'fire', 'security', 'facilities');
CREATE TYPE "emergency_status" AS ENUM ('reported', 'on_the_way', 'arrived', 'resolved', 'cancelled');

-- ----------------------------------------------------------------------------
-- Counters: the compound's E-, A- and S- numbers, taken under the counter's
-- row lock, last in every transaction. A rollback gives the number back.
-- ----------------------------------------------------------------------------
CREATE TABLE "safety_counters" (
    "tenant_id" UUID NOT NULL,
    "series" "safety_counter_series" NOT NULL,
    "last_number" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "safety_counters_pkey" PRIMARY KEY ("tenant_id", "series")
);
ALTER TABLE "safety_counters" ADD CONSTRAINT "safety_counters_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "safety_counters" ADD CONSTRAINT "safety_counters_last_number"
  CHECK ("last_number" >= 0);

-- ----------------------------------------------------------------------------
-- Emergencies.
-- ----------------------------------------------------------------------------
CREATE TABLE "emergencies" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "unit_id" UUID NOT NULL,
    "type" "emergency_type" NOT NULL,
    "status" "emergency_status" NOT NULL DEFAULT 'reported',
    "reported_by_account_id" UUID NOT NULL,
    "reported_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- How many responders were told when it was reported.
    "responders_notified" INTEGER NOT NULL,
    "escalated_at" TIMESTAMPTZ(3),
    "escalation_reason" TEXT,
    "responder_account_id" UUID,
    -- The gate of the responder's shift; null for a responder not at a gate.
    "responder_gate_id" UUID,
    "eta_minutes" INTEGER,
    "accepted_at" TIMESTAMPTZ(3),
    "arrived_at" TIMESTAMPTZ(3),
    "closed_at" TIMESTAMPTZ(3),
    "closed_by_account_id" UUID,
    "close_side" TEXT,
    "close_reason" TEXT,
    -- The staff's words on resolving it: kept through any erasure.
    "close_note" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "emergencies_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "emergencies_tenant_id_id_key" ON "emergencies"("tenant_id", "id");
CREATE UNIQUE INDEX "emergencies_number_key" ON "emergencies"("tenant_id", "number");
-- One open emergency per unit and type.
CREATE UNIQUE INDEX "emergencies_one_open"
  ON "emergencies"("tenant_id", "unit_id", "type")
  WHERE "status" IN ('reported', 'on_the_way', 'arrived');
CREATE INDEX "emergencies_status_idx"
  ON "emergencies"("tenant_id", "status", "reported_at", "id");
CREATE INDEX "emergencies_reporter_idx"
  ON "emergencies"("tenant_id", "reported_by_account_id", "reported_at", "id");
CREATE INDEX "emergencies_unit_idx"
  ON "emergencies"("tenant_id", "unit_id", "reported_at", "id");
-- What the escalation sweep reads.
CREATE INDEX "emergencies_unanswered_idx"
  ON "emergencies"("tenant_id", "reported_at")
  WHERE "status" = 'reported' AND "escalated_at" IS NULL;
ALTER TABLE "emergencies"
  ADD CONSTRAINT "emergencies_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "emergencies_tenant_id_unit_id_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "emergencies_tenant_id_reporter_fkey"
  FOREIGN KEY ("tenant_id", "reported_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "emergencies_tenant_id_responder_fkey"
  FOREIGN KEY ("tenant_id", "responder_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "emergencies_tenant_id_responder_gate_fkey"
  FOREIGN KEY ("tenant_id", "responder_gate_id") REFERENCES "gates"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "emergencies_tenant_id_closed_by_fkey"
  FOREIGN KEY ("tenant_id", "closed_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "emergencies" ADD CONSTRAINT "emergencies_number_positive"
  CHECK ("number" > 0 AND "responders_notified" >= 0);
-- The minutes a responder may pick (ADR 0047): no GPS, a countdown.
ALTER TABLE "emergencies" ADD CONSTRAINT "emergencies_eta"
  CHECK ("eta_minutes" IS NULL OR "eta_minutes" IN (2, 5, 10, 15));
ALTER TABLE "emergencies" ADD CONSTRAINT "emergencies_escalation"
  CHECK (("escalated_at" IS NULL) = ("escalation_reason" IS NULL)
     AND ("escalation_reason" IS NULL OR "escalation_reason" IN ('timeout', 'no_responders')));
-- Accepted: a responder, their minutes and the time, together.
ALTER TABLE "emergencies" ADD CONSTRAINT "emergencies_accept_shape"
  CHECK (("accepted_at" IS NULL) = ("responder_account_id" IS NULL)
     AND ("accepted_at" IS NULL) = ("eta_minutes" IS NULL)
     AND ("responder_gate_id" IS NULL OR "accepted_at" IS NOT NULL)
     AND ("arrived_at" IS NULL OR "accepted_at" IS NOT NULL));
-- Closed: when, by whom, from which side, together.
ALTER TABLE "emergencies" ADD CONSTRAINT "emergencies_close_shape"
  CHECK (("closed_at" IS NULL) = ("closed_by_account_id" IS NULL)
     AND ("closed_at" IS NULL) = ("close_side" IS NULL)
     AND ("close_note" IS NULL OR "closed_at" IS NOT NULL));
-- The status agrees with the times. status is NOT NULL.
ALTER TABLE "emergencies" ADD CONSTRAINT "emergencies_state_shape"
  CHECK (("status" IN ('resolved', 'cancelled')) = ("closed_at" IS NOT NULL)
     AND ("status" <> 'reported' OR "accepted_at" IS NULL)
     AND ("status" <> 'on_the_way' OR ("accepted_at" IS NOT NULL AND "arrived_at" IS NULL))
     AND ("status" <> 'arrived' OR "arrived_at" IS NOT NULL));
-- Who closes it, and why: REASON_CODES.emergencyCancel (optional) and
-- emergencyResolve (required); a unit test keeps them in step.
ALTER TABLE "emergencies" ADD CONSTRAINT "emergencies_close_side"
  CHECK ("close_side" IS NULL
      OR ("status" = 'cancelled' AND "close_side" = 'reporter')
      OR ("status" = 'resolved' AND "close_side" IN ('responder', 'staff')));
ALTER TABLE "emergencies" ADD CONSTRAINT "emergencies_cancel_reason"
  CHECK ("status" <> 'cancelled' OR "close_reason" IS NULL
      OR "close_reason" IN ('false_alarm', 'resolved_ourselves', 'other'));
ALTER TABLE "emergencies" ADD CONSTRAINT "emergencies_resolve_reason"
  CHECK ("status" <> 'resolved'
      OR ("close_reason" IS NOT NULL
          AND "close_reason" IN ('handled', 'false_alarm', 'transferred_ambulance', 'transferred_civil_defense', 'other')));
ALTER TABLE "emergencies" ADD CONSTRAINT "emergencies_close_reason_open"
  CHECK ("close_reason" IS NULL OR "closed_at" IS NOT NULL);
ALTER TABLE "emergencies" ADD CONSTRAINT "emergencies_close_note_length"
  CHECK ("close_note" IS NULL OR char_length("close_note") BETWEEN 1 AND 500);

-- An emergency moves forward only: who reported what, where and when never
-- changes; it is accepted once, arrived at once, escalated once and closed
-- once; a closed one never changes again. Never deleted.
CREATE FUNCTION emergency_moves_forward() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."number" = OLD."number"
     AND NEW."unit_id" = OLD."unit_id"
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
CREATE TRIGGER emergencies_move_forward
  BEFORE UPDATE OR DELETE ON "emergencies"
  FOR EACH ROW EXECUTE FUNCTION emergency_moves_forward();
CREATE TRIGGER emergencies_move_forward_truncate
  BEFORE TRUNCATE ON "emergencies"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Family alerts: who among the others living in the unit was told, and
-- whether they answered "on my way" (once).
-- ----------------------------------------------------------------------------
CREATE TABLE "emergency_family_alerts" (
    "tenant_id" UUID NOT NULL,
    "emergency_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "notified_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "on_my_way_at" TIMESTAMPTZ(3),
    CONSTRAINT "emergency_family_alerts_pkey" PRIMARY KEY ("tenant_id", "emergency_id", "account_id")
);
CREATE INDEX "emergency_family_alerts_account_idx"
  ON "emergency_family_alerts"("tenant_id", "account_id", "notified_at");
ALTER TABLE "emergency_family_alerts"
  ADD CONSTRAINT "emergency_family_alerts_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "emergency_family_alerts_emergency_fkey"
  FOREIGN KEY ("tenant_id", "emergency_id") REFERENCES "emergencies"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "emergency_family_alerts_account_fkey"
  FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION emergency_family_alert_answers_once() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."emergency_id" = OLD."emergency_id"
     AND NEW."account_id" = OLD."account_id"
     AND NEW."notified_at" = OLD."notified_at"
     AND (NEW."on_my_way_at" IS NOT DISTINCT FROM OLD."on_my_way_at"
          OR OLD."on_my_way_at" IS NULL) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'emergency_family_alerts: an alert is answered once and never deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER emergency_family_alerts_answer_once
  BEFORE UPDATE OR DELETE ON "emergency_family_alerts"
  FOR EACH ROW EXECUTE FUNCTION emergency_family_alert_answers_once();
CREATE TRIGGER emergency_family_alerts_answer_once_truncate
  BEFORE TRUNCATE ON "emergency_family_alerts"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Privileges and RLS. Nothing here is ever deleted.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "safety_counters", "emergencies", "emergency_family_alerts" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "safety_counters", "emergencies", "emergency_family_alerts" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['safety_counters', 'emergencies', 'emergency_family_alerts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
