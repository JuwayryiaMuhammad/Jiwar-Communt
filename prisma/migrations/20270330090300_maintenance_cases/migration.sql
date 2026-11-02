-- ============================================================================
-- Community cases (ADR 0081): one problem many households report.
--
-- When a resident's ticket lands in a unit of a building, and its category
-- has as many residents' tickets in that building within the compound's
-- window as its threshold says (none of them in a case yet, none
-- sensitive), a case opens and takes them all; while it is open, the next
-- such ticket joins it. One open case per category and building: the
-- ticket counter's row lock orders two landings (each sees the other's
-- commit), and the partial unique index backs it. The dispatch may add a
-- ticket of the building by hand, open the case's one work order (ADR 0076's
-- path), and resolve it (the reporters told) or dismiss it, once, with a
-- reason code.
--
-- The building has no foreign key: a building is deleted once its units
-- have left it (ADR 0072), and its cases keep its id. A ticket is in one
-- case, ever (the link's key); a link is never changed and never made to a
-- closed case (the triggers).
-- ============================================================================

CREATE TABLE "maintenance_cases" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "building_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "opened_at" TIMESTAMPTZ(3) NOT NULL,
    "opened_by_account_id" UUID,
    "work_order_ticket_id" UUID,
    "closed_at" TIMESTAMPTZ(3),
    "closed_by_account_id" UUID,
    "reason_code" TEXT,
    CONSTRAINT "maintenance_cases_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "maintenance_cases_tenant_id_id_key" ON "maintenance_cases"("tenant_id", "id");
CREATE INDEX "maintenance_cases_list_idx"
  ON "maintenance_cases"("tenant_id", "status", "opened_at" DESC, "id" DESC);
CREATE UNIQUE INDEX "maintenance_cases_one_open"
  ON "maintenance_cases"("tenant_id", "category_id", "building_id") WHERE "status" = 'open';
CREATE UNIQUE INDEX "maintenance_cases_one_work_order"
  ON "maintenance_cases"("tenant_id", "work_order_ticket_id") WHERE "work_order_ticket_id" IS NOT NULL;
ALTER TABLE "maintenance_cases" ADD CONSTRAINT "maintenance_cases_tenant_id_category_id_fkey"
  FOREIGN KEY ("tenant_id", "category_id") REFERENCES "ticket_categories"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "maintenance_cases" ADD CONSTRAINT "maintenance_cases_tenant_id_opened_by_fkey"
  FOREIGN KEY ("tenant_id", "opened_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "maintenance_cases" ADD CONSTRAINT "maintenance_cases_tenant_id_closed_by_fkey"
  FOREIGN KEY ("tenant_id", "closed_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "maintenance_cases" ADD CONSTRAINT "maintenance_cases_tenant_id_work_order_fkey"
  FOREIGN KEY ("tenant_id", "work_order_ticket_id") REFERENCES "tickets"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "maintenance_cases" ADD CONSTRAINT "maintenance_cases_status_known"
  CHECK ("status" IN ('open', 'resolved', 'dismissed'));
-- Open: nobody closed it. Closed: by someone, at a time, with a reason code.
ALTER TABLE "maintenance_cases" ADD CONSTRAINT "maintenance_cases_closed_shape"
  CHECK ((("status" = 'open') = ("closed_at" IS NULL))
     AND (("closed_at" IS NULL) = ("closed_by_account_id" IS NULL))
     AND (("closed_at" IS NULL) = ("reason_code" IS NULL)));

-- Closed once; its category, building and opening never change; its work
-- order is set once.
CREATE FUNCTION "maintenance_cases_closed_once"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" <> 'open'
     OR NEW."category_id" <> OLD."category_id"
     OR NEW."building_id" <> OLD."building_id"
     OR NEW."opened_at" <> OLD."opened_at"
     OR NEW."opened_by_account_id" IS DISTINCT FROM OLD."opened_by_account_id"
     OR (OLD."work_order_ticket_id" IS NOT NULL
         AND NEW."work_order_ticket_id" IS DISTINCT FROM OLD."work_order_ticket_id") THEN
    RAISE EXCEPTION 'a maintenance case is closed once' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "maintenance_cases_closed_once" BEFORE UPDATE ON "maintenance_cases"
  FOR EACH ROW EXECUTE FUNCTION "maintenance_cases_closed_once"();

REVOKE ALL ON "maintenance_cases" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "maintenance_cases" TO jiwar_app;
ALTER TABLE "maintenance_cases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "maintenance_cases" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "maintenance_cases"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE "maintenance_case_tickets" (
    "tenant_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "linked_at" TIMESTAMPTZ(3) NOT NULL,
    "linked_by_account_id" UUID,
    CONSTRAINT "maintenance_case_tickets_pkey" PRIMARY KEY ("tenant_id", "ticket_id")
);
CREATE INDEX "maintenance_case_tickets_case_idx"
  ON "maintenance_case_tickets"("tenant_id", "case_id", "linked_at", "ticket_id");
ALTER TABLE "maintenance_case_tickets" ADD CONSTRAINT "maintenance_case_tickets_tenant_id_case_id_fkey"
  FOREIGN KEY ("tenant_id", "case_id") REFERENCES "maintenance_cases"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "maintenance_case_tickets" ADD CONSTRAINT "maintenance_case_tickets_tenant_id_ticket_id_fkey"
  FOREIGN KEY ("tenant_id", "ticket_id") REFERENCES "tickets"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "maintenance_case_tickets" ADD CONSTRAINT "maintenance_case_tickets_tenant_id_linked_by_fkey"
  FOREIGN KEY ("tenant_id", "linked_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- A link is made to an open case only (the case's row is locked by its
-- writers, so a link and a close never cross), and never changed. After the
-- row is written, so the tenant's policy and the foreign keys (the RI
-- triggers sort first) answer before it.
CREATE FUNCTION "maintenance_case_tickets_to_open_case"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "maintenance_cases" c
                  WHERE c."id" = NEW."case_id" AND c."status" = 'open') THEN
    RAISE EXCEPTION 'a ticket joins an open case only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "maintenance_case_tickets_to_open_case" AFTER INSERT ON "maintenance_case_tickets"
  FOR EACH ROW EXECUTE FUNCTION "maintenance_case_tickets_to_open_case"();
CREATE TRIGGER maintenance_case_tickets_immutable_rows
  BEFORE UPDATE OR DELETE ON "maintenance_case_tickets"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER maintenance_case_tickets_immutable_truncate
  BEFORE TRUNCATE ON "maintenance_case_tickets"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "maintenance_case_tickets" FROM jiwar_app;
GRANT SELECT, INSERT ON "maintenance_case_tickets" TO jiwar_app;
ALTER TABLE "maintenance_case_tickets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "maintenance_case_tickets" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "maintenance_case_tickets"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
