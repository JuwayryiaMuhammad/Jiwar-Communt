-- ============================================================================
-- Readiness (ADR 0067): the compound's programs for a season (Ramadan, Eid,
-- summer), an event or an emergency, each over days of its own — the
-- holidays move, so a program states them — and their items: a task, an
-- estimate of what it will cost, a maintenance contract to review before the
-- program ends, or an inspection campaign. An item has an owner, a day it is
-- due by, and is done or called off once. A program is closed once; a copy
-- of one keeps a link to it. Nothing here is deleted; no free text but the
-- titles.
-- ============================================================================

CREATE TABLE "readiness_programs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE NOT NULL,
    "copied_from_id" UUID,
    "closed_at" TIMESTAMPTZ(3),
    "closed_by_account_id" UUID,
    "created_by_account_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "readiness_programs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "readiness_programs_tenant_id_id_key" ON "readiness_programs"("tenant_id", "id");
CREATE INDEX "readiness_programs_list_idx" ON "readiness_programs"("tenant_id", "starts_on", "id");
-- A program is copied to a given start once: a copy sent twice is one copy.
CREATE UNIQUE INDEX "readiness_programs_copy_key"
  ON "readiness_programs"("tenant_id", "copied_from_id", "starts_on")
  WHERE "copied_from_id" IS NOT NULL;
ALTER TABLE "readiness_programs" ADD CONSTRAINT "readiness_programs_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "readiness_programs" ADD CONSTRAINT "readiness_programs_copied_from_fkey"
  FOREIGN KEY ("tenant_id", "copied_from_id") REFERENCES "readiness_programs"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "readiness_programs" ADD CONSTRAINT "readiness_programs_closed_by_fkey"
  FOREIGN KEY ("tenant_id", "closed_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "readiness_programs" ADD CONSTRAINT "readiness_programs_created_by_fkey"
  FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- READINESS_KINDS in src/maintenance/readiness/readiness-rules.ts.
ALTER TABLE "readiness_programs" ADD CONSTRAINT "readiness_programs_kind_known"
  CHECK ("kind" IN ('season', 'event', 'emergency'));
ALTER TABLE "readiness_programs" ADD CONSTRAINT "readiness_programs_title_length"
  CHECK (char_length("title") BETWEEN 1 AND 120 AND "title" = btrim("title"));
-- At most a year and a day, as every window here.
ALTER TABLE "readiness_programs" ADD CONSTRAINT "readiness_programs_window"
  CHECK ("ends_on" >= "starts_on" AND "ends_on" <= "starts_on" + 366);
-- Who closed it only with when; an erasure may null who.
ALTER TABLE "readiness_programs" ADD CONSTRAINT "readiness_programs_closed_shape"
  CHECK ("closed_by_account_id" IS NULL OR "closed_at" IS NOT NULL);
ALTER TABLE "readiness_programs" ADD CONSTRAINT "readiness_programs_not_self"
  CHECK ("copied_from_id" IS NULL OR "copied_from_id" <> "id");

-- A program keeps its kind and where it was copied from; it is closed once
-- and then never changes. An erasure may null who closed or made it.
CREATE FUNCTION "readiness_programs_close_once"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a readiness program is never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."kind" <> OLD."kind"
     OR NEW."copied_from_id" IS DISTINCT FROM OLD."copied_from_id"
     OR NEW."created_at" <> OLD."created_at"
     OR (NEW."created_by_account_id" IS DISTINCT FROM OLD."created_by_account_id"
         AND NEW."created_by_account_id" IS NOT NULL)
     OR (OLD."closed_at" IS NOT NULL AND (
          NEW."closed_at" IS DISTINCT FROM OLD."closed_at"
       OR NEW."title" <> OLD."title"
       OR NEW."starts_on" <> OLD."starts_on"
       OR NEW."ends_on" <> OLD."ends_on"
       OR (NEW."closed_by_account_id" IS DISTINCT FROM OLD."closed_by_account_id"
           AND NEW."closed_by_account_id" IS NOT NULL))) THEN
    RAISE EXCEPTION 'a readiness program keeps its kind, and a closed one never changes'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "readiness_programs_close_once" BEFORE UPDATE OR DELETE ON "readiness_programs"
  FOR EACH ROW EXECUTE FUNCTION "readiness_programs_close_once"();
CREATE TRIGGER "readiness_programs_close_once_truncate" BEFORE TRUNCATE ON "readiness_programs"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- A program's items. A contract review names the maintenance contract and,
-- once done, what was decided; an inspection campaign names the checklist
-- its inspections run (ADR 0067; they are spawned by the next migration's
-- table); an estimate names an amount, in EGP, never a float. Done once or
-- called off once, never both; then it never changes. The sweep tells the
-- owner once that it is overdue.
-- ----------------------------------------------------------------------------
CREATE TABLE "readiness_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "program_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "owner_account_id" UUID NOT NULL,
    "due_on" DATE NOT NULL,
    "estimate_amount" DECIMAL(12,2),
    "contract_id" UUID,
    "checklist_id" UUID,
    "decision" TEXT,
    "done_at" TIMESTAMPTZ(3),
    "done_by_account_id" UUID,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by_account_id" UUID,
    "cancel_reason" TEXT,
    "overdue_notified_at" TIMESTAMPTZ(3),
    "copied_from_id" UUID,
    "created_by_account_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "readiness_items_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "readiness_items_tenant_id_id_key" ON "readiness_items"("tenant_id", "id");
CREATE INDEX "readiness_items_program_idx" ON "readiness_items"("tenant_id", "program_id", "due_on", "id");
CREATE INDEX "readiness_items_owner_idx" ON "readiness_items"("tenant_id", "owner_account_id", "due_on", "id")
  WHERE "done_at" IS NULL AND "cancelled_at" IS NULL;
-- What the overdue sweep reads: open items not yet told about.
CREATE INDEX "readiness_items_overdue_idx" ON "readiness_items"("tenant_id", "due_on", "id")
  WHERE "done_at" IS NULL AND "cancelled_at" IS NULL AND "overdue_notified_at" IS NULL;
-- A contract is reviewed once per program, unless that review was called off.
CREATE UNIQUE INDEX "readiness_items_contract_key"
  ON "readiness_items"("tenant_id", "program_id", "contract_id")
  WHERE "contract_id" IS NOT NULL AND "cancelled_at" IS NULL;
ALTER TABLE "readiness_items" ADD CONSTRAINT "readiness_items_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "readiness_items" ADD CONSTRAINT "readiness_items_program_fkey"
  FOREIGN KEY ("tenant_id", "program_id") REFERENCES "readiness_programs"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "readiness_items" ADD CONSTRAINT "readiness_items_owner_fkey"
  FOREIGN KEY ("tenant_id", "owner_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "readiness_items" ADD CONSTRAINT "readiness_items_contract_fkey"
  FOREIGN KEY ("tenant_id", "contract_id") REFERENCES "maintenance_contracts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "readiness_items" ADD CONSTRAINT "readiness_items_checklist_fkey"
  FOREIGN KEY ("tenant_id", "checklist_id") REFERENCES "checklist_templates"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "readiness_items" ADD CONSTRAINT "readiness_items_copied_from_fkey"
  FOREIGN KEY ("tenant_id", "copied_from_id") REFERENCES "readiness_items"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "readiness_items" ADD CONSTRAINT "readiness_items_done_by_fkey"
  FOREIGN KEY ("tenant_id", "done_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "readiness_items" ADD CONSTRAINT "readiness_items_cancelled_by_fkey"
  FOREIGN KEY ("tenant_id", "cancelled_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "readiness_items" ADD CONSTRAINT "readiness_items_created_by_fkey"
  FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- READINESS_ITEM_KINDS in src/maintenance/readiness/readiness-rules.ts.
ALTER TABLE "readiness_items" ADD CONSTRAINT "readiness_items_kind_known"
  CHECK ("kind" IN ('task', 'inspection_campaign', 'contract_review', 'estimate'));
ALTER TABLE "readiness_items" ADD CONSTRAINT "readiness_items_title_length"
  CHECK (char_length("title") BETWEEN 1 AND 120 AND "title" = btrim("title"));
-- What each kind names, and nothing it does not: a contract only for a
-- review, a checklist only for a campaign, an amount always for an
-- estimate (and optionally for a task).
ALTER TABLE "readiness_items" ADD CONSTRAINT "readiness_items_kind_shape"
  CHECK (("contract_id" IS NOT NULL) = ("kind" = 'contract_review')
     AND ("checklist_id" IS NOT NULL) = ("kind" = 'inspection_campaign')
     AND ("kind" <> 'estimate' OR "estimate_amount" IS NOT NULL)
     AND ("kind" IN ('estimate', 'task') OR "estimate_amount" IS NULL));
ALTER TABLE "readiness_items" ADD CONSTRAINT "readiness_items_estimate_range"
  CHECK ("estimate_amount" IS NULL
      OR ("estimate_amount" > 0 AND "estimate_amount" < 10000000000));
-- Done or called off, never both. A review's decision only with its done
-- (REASON_CODES.contractReviewDecision); the reason only with the cancel
-- (REASON_CODES.readinessItemCancel). Who did it may be nulled by an
-- erasure, or never was: a campaign is done by its last inspection.
ALTER TABLE "readiness_items" ADD CONSTRAINT "readiness_items_state_shape"
  CHECK (("done_at" IS NULL OR "cancelled_at" IS NULL)
     AND ("done_by_account_id" IS NULL OR "done_at" IS NOT NULL)
     AND ("cancelled_by_account_id" IS NULL OR "cancelled_at" IS NOT NULL)
     AND ("cancelled_at" IS NULL) = ("cancel_reason" IS NULL)
     AND ("decision" IS NULL OR ("kind" = 'contract_review' AND "done_at" IS NOT NULL))
     AND ("kind" <> 'contract_review' OR "done_at" IS NULL OR "decision" IS NOT NULL));
ALTER TABLE "readiness_items" ADD CONSTRAINT "readiness_items_decision_known"
  CHECK ("decision" IS NULL OR "decision" IN ('renew', 'replace', 'end'));
ALTER TABLE "readiness_items" ADD CONSTRAINT "readiness_items_cancel_reason_known"
  CHECK ("cancel_reason" IS NULL
      OR "cancel_reason" IN ('not_needed', 'covered_elsewhere', 'out_of_budget', 'other'));
ALTER TABLE "readiness_items" ADD CONSTRAINT "readiness_items_not_self"
  CHECK ("copied_from_id" IS NULL OR "copied_from_id" <> "id");

-- An item keeps its program, kind, what it names and where it was copied
-- from; it is done or called off once and then never changes, but for the
-- sweep's one mark, which only a later day clears (a new chance to be on
-- time). An erasure may null who did it.
CREATE FUNCTION "readiness_items_end_once"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a readiness item is never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."program_id" <> OLD."program_id" OR NEW."kind" <> OLD."kind"
     OR NEW."contract_id" IS DISTINCT FROM OLD."contract_id"
     OR NEW."checklist_id" IS DISTINCT FROM OLD."checklist_id"
     OR NEW."copied_from_id" IS DISTINCT FROM OLD."copied_from_id"
     OR NEW."created_at" <> OLD."created_at"
     OR (NEW."created_by_account_id" IS DISTINCT FROM OLD."created_by_account_id"
         AND NEW."created_by_account_id" IS NOT NULL)
     OR (OLD."overdue_notified_at" IS NOT NULL
         AND NEW."overdue_notified_at" IS DISTINCT FROM OLD."overdue_notified_at"
         AND NOT (NEW."overdue_notified_at" IS NULL AND NEW."due_on" > OLD."due_on"))
     OR ((OLD."done_at" IS NOT NULL OR OLD."cancelled_at" IS NOT NULL) AND (
          NEW."done_at" IS DISTINCT FROM OLD."done_at"
       OR NEW."cancelled_at" IS DISTINCT FROM OLD."cancelled_at"
       OR NEW."cancel_reason" IS DISTINCT FROM OLD."cancel_reason"
       OR NEW."decision" IS DISTINCT FROM OLD."decision"
       OR NEW."title" <> OLD."title"
       OR NEW."due_on" <> OLD."due_on"
       OR NEW."estimate_amount" IS DISTINCT FROM OLD."estimate_amount"
       OR NEW."owner_account_id" <> OLD."owner_account_id"
       OR (NEW."done_by_account_id" IS DISTINCT FROM OLD."done_by_account_id"
           AND NEW."done_by_account_id" IS NOT NULL)
       OR (NEW."cancelled_by_account_id" IS DISTINCT FROM OLD."cancelled_by_account_id"
           AND NEW."cancelled_by_account_id" IS NOT NULL))) THEN
    RAISE EXCEPTION 'a readiness item keeps what it names, and is done or called off once'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "readiness_items_end_once" BEFORE UPDATE OR DELETE ON "readiness_items"
  FOR EACH ROW EXECUTE FUNCTION "readiness_items_end_once"();
CREATE TRIGGER "readiness_items_end_once_truncate" BEFORE TRUNCATE ON "readiness_items"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Grants: both change in place under FOR UPDATE (a program before its
-- items). RLS, FORCE.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "readiness_programs", "readiness_items" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "readiness_programs", "readiness_items" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['readiness_programs', 'readiness_items'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
