-- ============================================================================
-- Phase 2.2 — worker compliance cases and card incidents (ADR 0022).
-- A worker found to be under 18 opens a compliance case (reported to the
-- holders of workers.compliance, not left to the resident) and records that
-- the wage is paid in full. A lost or confiscated card is an incident: the
-- replacement is free, and a confiscation reaches management and security,
-- never the resident.
-- ============================================================================

CREATE TYPE "compliance_case_kind" AS ENUM ('underage');
CREATE TYPE "compliance_case_status" AS ENUM ('open', 'closed');
CREATE TYPE "compliance_case_source" AS ENUM ('review', 'birth_date_correction', 'report');
CREATE TYPE "card_incident_type" AS ENUM ('lost', 'confiscated');
CREATE TYPE "card_incident_status" AS ENUM ('open', 'closed');
CREATE TYPE "card_incident_reporter" AS ENUM ('manager', 'resident');

CREATE TABLE "worker_compliance_cases" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "worker_id" UUID NOT NULL,
    "kind" "compliance_case_kind" NOT NULL,
    "status" "compliance_case_status" NOT NULL DEFAULT 'open',
    "source" "compliance_case_source" NOT NULL,
    "reason_code" TEXT,
    -- Compliance's own notes; erasable, never audited.
    "note" TEXT,
    "opened_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "opened_by" UUID,
    "closed_at" TIMESTAMPTZ(3),
    "closed_by" UUID,
    "close_reason_code" TEXT,
    "close_note" TEXT,
    CONSTRAINT "worker_compliance_cases_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "worker_compliance_cases_one_open_per_kind"
  ON "worker_compliance_cases"("worker_id", "kind") WHERE "status" = 'open';
CREATE INDEX "worker_compliance_cases_tenant_id_opened_at_idx"
  ON "worker_compliance_cases"("tenant_id", "opened_at" DESC);
ALTER TABLE "worker_compliance_cases"
  ADD CONSTRAINT "worker_compliance_cases_tenant_id_worker_id_fkey"
  FOREIGN KEY ("tenant_id", "worker_id") REFERENCES "domestic_workers"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "worker_compliance_cases_tenant_id_opened_by_fkey"
  FOREIGN KEY ("tenant_id", "opened_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "worker_compliance_cases_tenant_id_closed_by_fkey"
  FOREIGN KEY ("tenant_id", "closed_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "worker_compliance_cases" ADD CONSTRAINT "worker_compliance_cases_closed_is_complete"
  CHECK (("status" = 'open' AND "closed_at" IS NULL AND "close_reason_code" IS NULL)
      OR ("status" = 'closed' AND "closed_at" IS NOT NULL AND "close_reason_code" IS NOT NULL));
-- A report is a person's decision and says why.
ALTER TABLE "worker_compliance_cases" ADD CONSTRAINT "worker_compliance_cases_report_has_reason"
  CHECK ("source" <> 'report' OR ("reason_code" IS NOT NULL AND "opened_by" IS NOT NULL));

CREATE TABLE "worker_card_incidents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "engagement_id" UUID NOT NULL,
    "worker_id" UUID NOT NULL,
    "type" "card_incident_type" NOT NULL,
    "reported_via" "card_incident_reporter" NOT NULL,
    "reported_by" UUID NOT NULL,
    "reported_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Management and security only; never the resident, never audited.
    "note" TEXT,
    "status" "card_incident_status" NOT NULL DEFAULT 'open',
    "closed_at" TIMESTAMPTZ(3),
    "closed_by" UUID,
    CONSTRAINT "worker_card_incidents_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "worker_card_incidents_tenant_id_reported_at_idx"
  ON "worker_card_incidents"("tenant_id", "reported_at" DESC);
ALTER TABLE "worker_card_incidents"
  ADD CONSTRAINT "worker_card_incidents_tenant_id_engagement_id_fkey"
  FOREIGN KEY ("tenant_id", "engagement_id") REFERENCES "worker_engagements"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "worker_card_incidents_tenant_id_worker_id_fkey"
  FOREIGN KEY ("tenant_id", "worker_id") REFERENCES "domestic_workers"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "worker_card_incidents_tenant_id_reported_by_fkey"
  FOREIGN KEY ("tenant_id", "reported_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "worker_card_incidents_tenant_id_closed_by_fkey"
  FOREIGN KEY ("tenant_id", "closed_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- The confiscation may be the resident's own doing: only management files it.
ALTER TABLE "worker_card_incidents" ADD CONSTRAINT "worker_card_incidents_confiscation_by_manager"
  CHECK ("type" <> 'confiscated' OR "reported_via" = 'manager');
ALTER TABLE "worker_card_incidents" ADD CONSTRAINT "worker_card_incidents_closed_is_complete"
  CHECK (("status" = 'open') = ("closed_at" IS NULL));

REVOKE DELETE ON "worker_compliance_cases", "worker_card_incidents" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "worker_compliance_cases", "worker_card_incidents" TO jiwar_app;

ALTER TABLE "worker_compliance_cases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "worker_compliance_cases" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "worker_compliance_cases"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "worker_card_incidents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "worker_card_incidents" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "worker_card_incidents"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
