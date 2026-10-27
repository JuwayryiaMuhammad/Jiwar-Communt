-- ============================================================================
-- Maintenance plans (ADR 0064): an asset's planned work.
--
-- maintenance_plans               what is done to an asset, how often: on
--                                 the compound's calendar (every N days,
--                                 weeks, months or years from an anchor;
--                                 fixed, or floating from the last done)
--                                 or by usage (a metric's readings grow by
--                                 an interval). Its work orders go to the
--                                 asset's category, its checklist with
--                                 them; its owner answers for them.
-- maintenance_plan_occurrences    one due date: its work order, opened
--                                 `lead_days` before; done (on time when by
--                                 `due_on + grace_days`), skipped,
--                                 cancelled. Once per plan and original due
--                                 date: the sweep that opens it can run
--                                 twice, or race a reading, and open one.
-- maintenance_plan_events         what happened to a plan, append-only.
--
-- An asset in a unit takes no plan (the household books its check-ups,
-- ADR 0038). Retiring an asset deactivates its plans.
-- ============================================================================

CREATE TABLE "maintenance_plans" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "checklist_id" UUID,
    "title" TEXT NOT NULL,
    "category_id" UUID NOT NULL,
    "priority" "ticket_priority" NOT NULL DEFAULT 'normal',
    "trigger" TEXT NOT NULL,
    "every" SMALLINT,
    "unit" TEXT,
    "anchor_on" DATE,
    "basis" TEXT,
    "next_due_on" DATE,
    "metric_key" TEXT,
    "usage_interval" DECIMAL(14,4),
    "usage_last_value" DECIMAL(14,4),
    "lead_days" SMALLINT NOT NULL DEFAULT 7,
    "grace_days" SMALLINT NOT NULL DEFAULT 3,
    "owner_account_id" UUID NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "maintenance_plans_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "maintenance_plans_tenant_id_id_key" ON "maintenance_plans"("tenant_id", "id");
CREATE INDEX "maintenance_plans_asset_idx" ON "maintenance_plans"("tenant_id", "asset_id");
CREATE INDEX "maintenance_plans_due_idx" ON "maintenance_plans"("tenant_id", "next_due_on")
  WHERE "active" AND "trigger" = 'calendar';
CREATE INDEX "maintenance_plans_list_idx" ON "maintenance_plans"("tenant_id", "created_at" DESC, "id" DESC);
ALTER TABLE "maintenance_plans" ADD CONSTRAINT "maintenance_plans_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "maintenance_plans" ADD CONSTRAINT "maintenance_plans_asset_fkey"
  FOREIGN KEY ("tenant_id", "asset_id") REFERENCES "assets"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "maintenance_plans" ADD CONSTRAINT "maintenance_plans_checklist_fkey"
  FOREIGN KEY ("tenant_id", "checklist_id") REFERENCES "checklist_templates"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "maintenance_plans" ADD CONSTRAINT "maintenance_plans_category_fkey"
  FOREIGN KEY ("tenant_id", "category_id") REFERENCES "ticket_categories"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "maintenance_plans" ADD CONSTRAINT "maintenance_plans_owner_fkey"
  FOREIGN KEY ("tenant_id", "owner_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "maintenance_plans" ADD CONSTRAINT "maintenance_plans_title_length"
  CHECK (char_length("title") BETWEEN 1 AND 120);
ALTER TABLE "maintenance_plans" ADD CONSTRAINT "maintenance_plans_days_range"
  CHECK ("lead_days" BETWEEN 0 AND 60 AND "grace_days" BETWEEN 0 AND 60);
-- A calendar plan has its series (and a next due date unless a floating
-- one's occurrence is open); a usage plan its metric and interval.
ALTER TABLE "maintenance_plans" ADD CONSTRAINT "maintenance_plans_trigger_shape"
  CHECK (("trigger" = 'calendar'
          AND "every" IS NOT NULL AND "every" BETWEEN 1 AND 365
          AND "unit" IS NOT NULL AND "unit" IN ('day', 'week', 'month', 'year')
          AND "anchor_on" IS NOT NULL
          AND "basis" IS NOT NULL AND "basis" IN ('fixed', 'floating')
          AND ("next_due_on" IS NOT NULL OR "basis" = 'floating')
          AND "metric_key" IS NULL AND "usage_interval" IS NULL AND "usage_last_value" IS NULL)
      OR ("trigger" = 'usage'
          AND "metric_key" IS NOT NULL AND "metric_key" ~ '^[a-z][a-z0-9_]{1,39}$'
          AND "usage_interval" IS NOT NULL AND "usage_interval" > 0
          AND "every" IS NULL AND "unit" IS NULL AND "anchor_on" IS NULL
          AND "basis" IS NULL AND "next_due_on" IS NULL));

CREATE TABLE "maintenance_plan_occurrences" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "original_due_on" DATE NOT NULL,
    "due_on" DATE NOT NULL,
    "status" TEXT NOT NULL,
    "ticket_id" UUID,
    "generated_at" TIMESTAMPTZ(3) NOT NULL,
    "closed_at" TIMESTAMPTZ(3),
    "done_on" DATE,
    "on_time" BOOLEAN,
    "reason_code" TEXT,
    "overdue_alerted_at" TIMESTAMPTZ(3),
    CONSTRAINT "maintenance_plan_occurrences_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "maintenance_plan_occurrences_tenant_id_id_key"
  ON "maintenance_plan_occurrences"("tenant_id", "id");
CREATE UNIQUE INDEX "maintenance_plan_occurrences_once"
  ON "maintenance_plan_occurrences"("plan_id", "original_due_on");
CREATE UNIQUE INDEX "maintenance_plan_occurrences_ticket_key"
  ON "maintenance_plan_occurrences"("ticket_id") WHERE "ticket_id" IS NOT NULL;
CREATE INDEX "maintenance_plan_occurrences_plan_idx"
  ON "maintenance_plan_occurrences"("tenant_id", "plan_id", "due_on" DESC);
CREATE INDEX "maintenance_plan_occurrences_open_idx"
  ON "maintenance_plan_occurrences"("tenant_id", "due_on") WHERE "status" = 'open';
ALTER TABLE "maintenance_plan_occurrences" ADD CONSTRAINT "maintenance_plan_occurrences_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "maintenance_plan_occurrences" ADD CONSTRAINT "maintenance_plan_occurrences_plan_fkey"
  FOREIGN KEY ("tenant_id", "plan_id") REFERENCES "maintenance_plans"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "maintenance_plan_occurrences" ADD CONSTRAINT "maintenance_plan_occurrences_ticket_fkey"
  FOREIGN KEY ("tenant_id", "ticket_id") REFERENCES "tickets"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- Open: its work order, not closed. Done: the day, on time or not.
-- Skipped: a reason (REASON_CODES.planSkip), no work order. Cancelled: its
-- work order was cancelled, or its plan ended.
ALTER TABLE "maintenance_plan_occurrences" ADD CONSTRAINT "maintenance_plan_occurrences_state_shape"
  CHECK (("status" = 'open' AND "ticket_id" IS NOT NULL AND "closed_at" IS NULL
          AND "done_on" IS NULL AND "on_time" IS NULL AND "reason_code" IS NULL)
      OR ("status" = 'done' AND "ticket_id" IS NOT NULL AND "closed_at" IS NOT NULL
          AND "done_on" IS NOT NULL AND "on_time" IS NOT NULL AND "reason_code" IS NULL)
      OR ("status" = 'skipped' AND "ticket_id" IS NULL AND "closed_at" IS NOT NULL
          AND "done_on" IS NULL AND "on_time" IS NULL AND "reason_code" IS NOT NULL
          AND "reason_code" IN ('not_needed', 'asset_out_of_service', 'covered_by_other_work', 'other'))
      OR ("status" = 'cancelled' AND "closed_at" IS NOT NULL
          AND "done_on" IS NULL AND "on_time" IS NULL AND "reason_code" IS NOT NULL
          AND "reason_code" IN ('ticket_cancelled', 'plan_ended')));

-- Closed once: done, skipped or cancelled is final.
CREATE FUNCTION "maintenance_plan_occurrences_closed_once"() RETURNS trigger AS $$
BEGIN
  IF NEW."plan_id" <> OLD."plan_id" OR NEW."original_due_on" <> OLD."original_due_on"
     OR NEW."generated_at" <> OLD."generated_at"
     OR NEW."ticket_id" IS DISTINCT FROM OLD."ticket_id" THEN
    RAISE EXCEPTION 'an occurrence keeps its plan, date and work order' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."status" <> 'open' THEN
    RAISE EXCEPTION 'a closed occurrence never changes' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "maintenance_plan_occurrences_closed_once" BEFORE UPDATE ON "maintenance_plan_occurrences"
  FOR EACH ROW EXECUTE FUNCTION "maintenance_plan_occurrences_closed_once"();
CREATE TRIGGER "maintenance_plan_occurrences_no_delete" BEFORE DELETE ON "maintenance_plan_occurrences"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER "maintenance_plan_occurrences_immutable_truncate" BEFORE TRUNCATE ON "maintenance_plan_occurrences"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

CREATE TABLE "maintenance_plan_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "occurrence_id" UUID,
    "kind" TEXT NOT NULL,
    "from_value" TEXT,
    "to_value" TEXT,
    "reason_code" TEXT,
    "actor_account_id" UUID,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "maintenance_plan_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "maintenance_plan_events_plan_idx"
  ON "maintenance_plan_events"("tenant_id", "plan_id", "occurred_at" DESC, "id" DESC);
ALTER TABLE "maintenance_plan_events" ADD CONSTRAINT "maintenance_plan_events_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "maintenance_plan_events" ADD CONSTRAINT "maintenance_plan_events_plan_fkey"
  FOREIGN KEY ("tenant_id", "plan_id") REFERENCES "maintenance_plans"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "maintenance_plan_events" ADD CONSTRAINT "maintenance_plan_events_kind_known"
  CHECK ("kind" IN ('created', 'updated', 'deactivated', 'reactivated', 'deferred', 'skipped',
                    'generated', 'done', 'cancelled', 'overdue'));
ALTER TABLE "maintenance_plan_events" ADD CONSTRAINT "maintenance_plan_events_values_length"
  CHECK (("from_value" IS NULL OR char_length("from_value") <= 400)
     AND ("to_value" IS NULL OR char_length("to_value") <= 400)
     AND ("reason_code" IS NULL OR char_length("reason_code") BETWEEN 1 AND 40));
CREATE TRIGGER "maintenance_plan_events_immutable_rows" BEFORE UPDATE OR DELETE ON "maintenance_plan_events"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER "maintenance_plan_events_immutable_truncate" BEFORE TRUNCATE ON "maintenance_plan_events"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- Who acted, in the same compound (composite keys, like every other
-- reference; an erasure nulls a person's columns, it deletes no account).
ALTER TABLE "maintenance_plan_events" ADD CONSTRAINT "maintenance_plan_events_actor_fkey"
  FOREIGN KEY ("tenant_id", "actor_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "maintenance_plan_events" ADD CONSTRAINT "maintenance_plan_events_occurrence_fkey"
  FOREIGN KEY ("tenant_id", "occurrence_id") REFERENCES "maintenance_plan_occurrences"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

REVOKE ALL ON "maintenance_plans", "maintenance_plan_occurrences", "maintenance_plan_events" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "maintenance_plans", "maintenance_plan_occurrences" TO jiwar_app;
GRANT SELECT, INSERT ON "maintenance_plan_events" TO jiwar_app;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['maintenance_plans', 'maintenance_plan_occurrences', 'maintenance_plan_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
