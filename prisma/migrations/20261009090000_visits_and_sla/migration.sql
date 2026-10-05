-- ============================================================================
-- Phase 5.3 — visits and the SLA (ADR 0034).
--
-- Only NEW tables and enums: no 5.1 or 5.2 table changes (ADR 0032, 0033).
--
-- A visit is a window in which the technician comes to a unit. Its window,
-- its absence-entry consent and its receiver tell when a home is empty: they
-- live on these rows only, never in the audit trail, never in a notification
-- beyond the window itself, and never in the visit's own history.
--
-- The SLA is event-sourced: `ticket_sla_events` is append-only, and
-- `ticket_sla_clocks` is a projection of it, written in the same
-- transaction as each event and rebuildable from the events alone.
--
-- The two history tables (visit events, SLA events) are append-only like
-- ticket_assignments: SELECT and INSERT for jiwar_app, triggers refuse
-- UPDATE, DELETE and TRUNCATE for every role, no foreign keys.
-- ============================================================================

CREATE TYPE "visit_status" AS ENUM
  ('proposed', 'confirmed', 'arrived', 'done', 'no_access', 'cancelled', 'rescheduled');
-- Which side acted. A dispatcher acts on the technician's side; `system` is
-- an automatic cancellation or a sweep.
CREATE TYPE "visit_side" AS ENUM ('technician', 'resident', 'system');
CREATE TYPE "visit_receiver_kind" AS ENUM ('household', 'worker');
CREATE TYPE "visit_event_kind" AS ENUM
  ('proposed', 'countered', 'confirmed', 'rescheduled', 'cancelled',
   'consent_granted', 'consent_revoked', 'consent_voided',
   'receiver_set', 'receiver_cleared',
   'arrived', 'done', 'no_access', 'late_notified');
CREATE TYPE "sla_clock" AS ENUM ('response', 'resolution');
CREATE TYPE "sla_event_kind" AS ENUM
  ('started', 'paused', 'resumed', 'met', 'breached', 'retargeted', 'stopped');
CREATE TYPE "sla_clock_state" AS ENUM ('running', 'paused', 'met', 'breached', 'stopped');

-- ----------------------------------------------------------------------------
-- Visits. At most one active (proposed, confirmed, arrived) per ticket.
-- ----------------------------------------------------------------------------
CREATE TABLE "ticket_visits" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    -- The ticket's cycle when the visit was proposed.
    "cycle" INTEGER NOT NULL,
    "technician_account_id" UUID NOT NULL,
    "status" "visit_status" NOT NULL DEFAULT 'proposed',
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "proposed_by_side" "visit_side" NOT NULL,
    -- Pointers (the technician, a dispatcher, a resident): an erased account
    -- stays a tombstone, so they never dangle.
    "proposed_by_account_id" UUID NOT NULL,
    -- The visit this one replaced (a counter-proposal or a reschedule).
    "previous_visit_id" UUID,
    "confirmed_at" TIMESTAMPTZ(3),
    "confirmed_by_account_id" UUID,
    -- Absence-entry consent: for this visit only, never carried over.
    "absence_entry_approved" BOOLEAN NOT NULL DEFAULT false,
    "consent_by_account_id" UUID,
    "consent_at" TIMESTAMPTZ(3),
    -- Who lets the technician in: a household account or a worker's
    -- engagement on the unit.
    "receiver_kind" "visit_receiver_kind",
    "receiver_account_id" UUID,
    "receiver_engagement_id" UUID,
    "arrived_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason_code" TEXT,
    "cancelled_by_side" "visit_side",
    "cancelled_by_account_id" UUID,
    "late_notified_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "ticket_visits_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ticket_visits_tenant_id_id_key" ON "ticket_visits"("tenant_id", "id");
CREATE UNIQUE INDEX "ticket_visits_one_active_per_ticket"
  ON "ticket_visits"("tenant_id", "ticket_id")
  WHERE "status" IN ('proposed', 'confirmed', 'arrived');
CREATE INDEX "ticket_visits_ticket_idx"
  ON "ticket_visits"("tenant_id", "ticket_id", "created_at", "id");
CREATE INDEX "ticket_visits_late_idx"
  ON "ticket_visits"("tenant_id", "starts_at")
  WHERE "status" = 'confirmed' AND "late_notified_at" IS NULL;
CREATE INDEX "ticket_visits_consent_idx"
  ON "ticket_visits"("tenant_id", "consent_by_account_id")
  WHERE "consent_by_account_id" IS NOT NULL;
CREATE INDEX "ticket_visits_receiver_idx"
  ON "ticket_visits"("tenant_id", "receiver_account_id")
  WHERE "receiver_account_id" IS NOT NULL;
ALTER TABLE "ticket_visits"
  ADD CONSTRAINT "ticket_visits_tenant_id_ticket_id_fkey"
  FOREIGN KEY ("tenant_id", "ticket_id") REFERENCES "tickets"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ticket_visits_tenant_id_technician_fkey"
  FOREIGN KEY ("tenant_id", "technician_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ticket_visits_tenant_id_receiver_account_fkey"
  FOREIGN KEY ("tenant_id", "receiver_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ticket_visits_tenant_id_receiver_engagement_fkey"
  FOREIGN KEY ("tenant_id", "receiver_engagement_id") REFERENCES "worker_engagements"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ticket_visits_tenant_id_previous_fkey"
  FOREIGN KEY ("tenant_id", "previous_visit_id") REFERENCES "ticket_visits"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "ticket_visits" ADD CONSTRAINT "ticket_visits_cycle_positive"
  CHECK ("cycle" >= 1);
-- At most four hours. "At least 15 minutes from now, within 30 days" needs
-- the clock and is the service's (a CHECK must not depend on now()).
ALTER TABLE "ticket_visits" ADD CONSTRAINT "ticket_visits_window"
  CHECK ("ends_at" > "starts_at" AND "ends_at" <= "starts_at" + interval '4 hours');
ALTER TABLE "ticket_visits" ADD CONSTRAINT "ticket_visits_proposer_side"
  CHECK ("proposed_by_side" <> 'system');
ALTER TABLE "ticket_visits" ADD CONSTRAINT "ticket_visits_confirmed_shape"
  CHECK (("confirmed_at" IS NULL) = ("confirmed_by_account_id" IS NULL)
     AND ("status" IN ('proposed', 'cancelled', 'rescheduled') OR "confirmed_at" IS NOT NULL)
     AND ("status" <> 'proposed' OR "confirmed_at" IS NULL));
-- Consent: who and when, only on a confirmed (or later, kept) visit; a
-- cancelled or rescheduled visit's consent is void.
ALTER TABLE "ticket_visits" ADD CONSTRAINT "ticket_visits_consent_shape"
  CHECK ("absence_entry_approved" = ("consent_by_account_id" IS NOT NULL)
     AND "absence_entry_approved" = ("consent_at" IS NOT NULL)
     AND (NOT "absence_entry_approved"
          OR "status" IN ('confirmed', 'arrived', 'done', 'no_access')));
ALTER TABLE "ticket_visits" ADD CONSTRAINT "ticket_visits_receiver_shape"
  CHECK (("receiver_kind" IS NULL AND "receiver_account_id" IS NULL
          AND "receiver_engagement_id" IS NULL)
      OR ("receiver_kind" IS NOT DISTINCT FROM 'household'
          AND "receiver_account_id" IS NOT NULL AND "receiver_engagement_id" IS NULL
          AND "status" IN ('confirmed', 'arrived', 'done', 'no_access'))
      OR ("receiver_kind" IS NOT DISTINCT FROM 'worker'
          AND "receiver_engagement_id" IS NOT NULL AND "receiver_account_id" IS NULL
          AND "status" IN ('confirmed', 'arrived', 'done', 'no_access')));
ALTER TABLE "ticket_visits" ADD CONSTRAINT "ticket_visits_arrived_shape"
  CHECK (("status" IN ('arrived', 'done', 'no_access')) = ("arrived_at" IS NOT NULL));
ALTER TABLE "ticket_visits" ADD CONSTRAINT "ticket_visits_finished_shape"
  CHECK (("status" IN ('done', 'no_access')) = ("finished_at" IS NOT NULL));
-- Ended by a side: a person's side names the person, the system names
-- nobody. A cancellation carries a code; a counter-proposal (rescheduled)
-- may not.
ALTER TABLE "ticket_visits" ADD CONSTRAINT "ticket_visits_cancelled_shape"
  CHECK (("status" IN ('cancelled', 'rescheduled')) = ("cancelled_at" IS NOT NULL)
     AND ("status" IN ('cancelled', 'rescheduled')) = ("cancelled_by_side" IS NOT NULL)
     AND ("status" <> 'cancelled' OR "cancel_reason_code" IS NOT NULL)
     AND ("cancel_reason_code" IS NULL OR "status" IN ('cancelled', 'rescheduled'))
     AND (("cancelled_by_side" IS NULL AND "cancelled_by_account_id" IS NULL)
       OR ("cancelled_by_side" IS NOT DISTINCT FROM 'system'
           AND "cancelled_by_account_id" IS NULL)
       OR ("cancelled_by_side" IS NOT NULL
           AND "cancelled_by_side" IS DISTINCT FROM 'system'
           AND "cancelled_by_account_id" IS NOT NULL)));
ALTER TABLE "ticket_visits" ADD CONSTRAINT "ticket_visits_late_shape"
  CHECK ("late_notified_at" IS NULL OR "status" <> 'proposed');
ALTER TABLE "ticket_visits" ADD CONSTRAINT "ticket_visits_previous_not_self"
  CHECK ("previous_visit_id" IS NULL OR "previous_visit_id" IS DISTINCT FROM "id");

-- What happened to a visit, and who did it. No window times: the history is
-- for "who confirmed, who granted, who cancelled", not for "when was the
-- home empty". Dispatch reads it; nobody else.
CREATE TABLE "ticket_visit_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "visit_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "kind" "visit_event_kind" NOT NULL,
    "actor_side" "visit_side" NOT NULL,
    "actor_account_id" UUID,
    "reason_code" TEXT,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ticket_visit_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ticket_visit_events_ticket_idx"
  ON "ticket_visit_events"("tenant_id", "ticket_id", "at", "id");
ALTER TABLE "ticket_visit_events" ADD CONSTRAINT "ticket_visit_events_actor_shape"
  CHECK (("actor_side" = 'system') = ("actor_account_id" IS NULL));
ALTER TABLE "ticket_visit_events" ADD CONSTRAINT "ticket_visit_events_reason_shape"
  CHECK ("reason_code" IS NULL OR "reason_code" ~ '^[a-z][a-z0-9_]{1,39}$');

-- ----------------------------------------------------------------------------
-- SLA settings and targets. Off in every compound, like automatic dispatch:
-- a deploy must not start measuring anyone.
-- ----------------------------------------------------------------------------
CREATE TABLE "maintenance_sla_settings" (
    "tenant_id" UUID NOT NULL,
    "sla_enabled" BOOLEAN NOT NULL DEFAULT false,
    -- The last time it was turned on: a clock started before it belongs to
    -- an earlier activation and is stopped, never resumed.
    "enabled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "maintenance_sla_settings_pkey" PRIMARY KEY ("tenant_id")
);
ALTER TABLE "maintenance_sla_settings" ADD CONSTRAINT "maintenance_sla_settings_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "maintenance_sla_settings" ADD CONSTRAINT "maintenance_sla_settings_enabled_shape"
  CHECK (NOT "sla_enabled" OR "enabled_at" IS NOT NULL);

CREATE TABLE "sla_targets" (
    "tenant_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "priority" "ticket_priority" NOT NULL,
    "response_minutes" INTEGER NOT NULL,
    "resolution_minutes" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "sla_targets_pkey" PRIMARY KEY ("tenant_id", "category_id", "priority")
);
ALTER TABLE "sla_targets" ADD CONSTRAINT "sla_targets_tenant_id_category_id_fkey"
  FOREIGN KEY ("tenant_id", "category_id") REFERENCES "ticket_categories"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- Response up to a week, resolution up to 30 days, response first.
ALTER TABLE "sla_targets" ADD CONSTRAINT "sla_targets_ranges"
  CHECK ("response_minutes" BETWEEN 5 AND 10080
     AND "resolution_minutes" BETWEEN 15 AND 43200
     AND "response_minutes" <= "resolution_minutes");

-- ----------------------------------------------------------------------------
-- SLA events (append-only) and their projection. `cycle` is the SLA's own:
-- it starts at a ticket's creation, a reopen and an activation (a rejection
-- keeps it). `seq` orders a clock's events; elapsed time is always
-- computed from them, never stored.
-- ----------------------------------------------------------------------------
CREATE TABLE "ticket_sla_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "cycle" INTEGER NOT NULL,
    "clock" "sla_clock" NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" "sla_event_kind" NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "target_minutes" INTEGER NOT NULL,
    "reason_code" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ticket_sla_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ticket_sla_events_seq_key"
  ON "ticket_sla_events"("tenant_id", "ticket_id", "cycle", "clock", "seq");
CREATE UNIQUE INDEX "ticket_sla_events_one_start"
  ON "ticket_sla_events"("tenant_id", "ticket_id", "cycle", "clock")
  WHERE "kind" = 'started';
-- met, breached and stopped end a clock: never two of them, so `met` and
-- `breached` can never both be written for one clock.
CREATE UNIQUE INDEX "ticket_sla_events_one_end"
  ON "ticket_sla_events"("tenant_id", "ticket_id", "cycle", "clock")
  WHERE "kind" IN ('met', 'breached', 'stopped');
ALTER TABLE "ticket_sla_events" ADD CONSTRAINT "ticket_sla_events_shape"
  CHECK ("cycle" >= 1 AND "seq" >= 1 AND "target_minutes" > 0
     AND ("kind" = 'started') = ("seq" = 1));
ALTER TABLE "ticket_sla_events" ADD CONSTRAINT "ticket_sla_events_reason_shape"
  CHECK (("kind" NOT IN ('paused', 'retargeted', 'stopped') OR "reason_code" IS NOT NULL)
     AND ("reason_code" IS NULL OR "reason_code" ~ '^[a-z][a-z0-9_]{1,39}$'));

CREATE TABLE "ticket_sla_clocks" (
    "tenant_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "cycle" INTEGER NOT NULL,
    "clock" "sla_clock" NOT NULL,
    "state" "sla_clock_state" NOT NULL,
    "target_minutes" INTEGER NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "due_at" TIMESTAMPTZ(3),
    "paused_at" TIMESTAMPTZ(3),
    "ended_at" TIMESTAMPTZ(3),
    "last_seq" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "ticket_sla_clocks_pkey" PRIMARY KEY ("tenant_id", "ticket_id", "cycle", "clock")
);
CREATE INDEX "ticket_sla_clocks_due_idx"
  ON "ticket_sla_clocks"("tenant_id", "due_at") WHERE "state" = 'running';
ALTER TABLE "ticket_sla_clocks" ADD CONSTRAINT "ticket_sla_clocks_tenant_id_ticket_id_fkey"
  FOREIGN KEY ("tenant_id", "ticket_id") REFERENCES "tickets"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ticket_sla_clocks" ADD CONSTRAINT "ticket_sla_clocks_shape"
  CHECK ("cycle" >= 1 AND "last_seq" >= 1 AND "target_minutes" > 0
     AND ("state" = 'running') = ("due_at" IS NOT NULL)
     AND ("state" = 'paused') = ("paused_at" IS NOT NULL)
     AND ("state" IN ('met', 'breached', 'stopped')) = ("ended_at" IS NOT NULL));

CREATE TRIGGER ticket_visit_events_immutable_rows
  BEFORE UPDATE OR DELETE ON "ticket_visit_events"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER ticket_visit_events_immutable_truncate
  BEFORE TRUNCATE ON "ticket_visit_events"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER ticket_sla_events_immutable_rows
  BEFORE UPDATE OR DELETE ON "ticket_sla_events"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER ticket_sla_events_immutable_truncate
  BEFORE TRUNCATE ON "ticket_sla_events"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Privileges and RLS.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "ticket_visits", "ticket_visit_events", "maintenance_sla_settings",
  "sla_targets", "ticket_sla_events", "ticket_sla_clocks" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "ticket_visits", "maintenance_sla_settings",
  "sla_targets", "ticket_sla_clocks" TO jiwar_app;
GRANT SELECT, INSERT ON "ticket_visit_events", "ticket_sla_events" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ticket_visits', 'ticket_visit_events',
    'maintenance_sla_settings', 'sla_targets', 'ticket_sla_events',
    'ticket_sla_clocks'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- Existing compounds get what a new one gets (DEFAULT_SLA_TARGETS in
-- src/maintenance/sla/default-sla-targets.ts; a unit test keeps the two in
-- step): the SLA off, and the default targets for every category, active or
-- retired. FORCE RLS applies here too: one compound at a time.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', t."id"::text, true);
    INSERT INTO "maintenance_sla_settings" ("tenant_id", "sla_enabled", "updated_at")
      VALUES (t."id", false, CURRENT_TIMESTAMP);
    INSERT INTO "sla_targets"
      ("tenant_id", "category_id", "priority", "response_minutes", "resolution_minutes", "updated_at")
    SELECT t."id", c."id", d.priority::"ticket_priority", d.response, d.resolution, CURRENT_TIMESTAMP
      FROM "ticket_categories" c
     CROSS JOIN (VALUES
        ('emergency', 60, 1440),
        ('urgent', 240, 4320),
        ('normal', 1440, 10080)
      ) AS d(priority, response, resolution);
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
