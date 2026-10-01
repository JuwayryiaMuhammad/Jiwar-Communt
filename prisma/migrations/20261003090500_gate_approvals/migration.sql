-- ============================================================================
-- Phase 4 — approvals at the gate (ADR 0028). A guard asks a household
-- whether to let an uninvited visitor, a delivery or a worker outside their
-- schedule in. The first decision wins; a household's deny wins over its own
-- approval until the entry is recorded; nobody answering in time applies the
-- household's standing instruction (or refuses).
-- ============================================================================

CREATE TYPE "gate_request_kind" AS ENUM ('uninvited_visitor', 'delivery', 'worker_off_schedule');
CREATE TYPE "gate_request_status" AS ENUM ('pending', 'approved', 'denied', 'timed_out', 'leave_at_gate', 'withdrawn');
CREATE TYPE "gate_decision_source" AS ENUM ('household', 'standing_instruction', 'timeout', 'guard');

CREATE TABLE "gate_approval_requests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "gate_id" UUID NOT NULL,
    "shift_id" UUID NOT NULL,
    "requested_by" UUID NOT NULL,
    "kind" "gate_request_kind" NOT NULL,
    "party_size" INTEGER NOT NULL,
    "engagement_id" UUID,
    "visitor_details_id" UUID,
    "status" "gate_request_status" NOT NULL DEFAULT 'pending',
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "decision_source" "gate_decision_source",
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "gate_approval_requests_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "gate_approval_requests_tenant_id_id_key" ON "gate_approval_requests"("tenant_id", "id");
CREATE INDEX "gate_approval_requests_tenant_id_unit_id_status_idx"
  ON "gate_approval_requests"("tenant_id", "unit_id", "status");
CREATE INDEX "gate_approval_requests_pending_expiry_idx"
  ON "gate_approval_requests"("tenant_id", "expires_at") WHERE "status" = 'pending';
ALTER TABLE "gate_approval_requests"
  ADD CONSTRAINT "gate_approval_requests_tenant_id_unit_id_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_approval_requests_tenant_id_gate_id_fkey"
  FOREIGN KEY ("tenant_id", "gate_id") REFERENCES "gates"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_approval_requests_tenant_id_shift_id_fkey"
  FOREIGN KEY ("tenant_id", "shift_id") REFERENCES "guard_shifts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_approval_requests_tenant_id_requested_by_fkey"
  FOREIGN KEY ("tenant_id", "requested_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_approval_requests_tenant_id_decided_by_fkey"
  FOREIGN KEY ("tenant_id", "decided_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_approval_requests_tenant_id_engagement_id_fkey"
  FOREIGN KEY ("tenant_id", "engagement_id") REFERENCES "worker_engagements"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "gate_approval_requests_tenant_id_visitor_details_id_fkey"
  FOREIGN KEY ("tenant_id", "visitor_details_id") REFERENCES "visitor_details"("tenant_id", "id")
  ON DELETE SET NULL ("visitor_details_id") ON UPDATE RESTRICT;
ALTER TABLE "gate_approval_requests" ADD CONSTRAINT "gate_approval_requests_party_size_range"
  CHECK ("party_size" BETWEEN 1 AND 50);
ALTER TABLE "gate_approval_requests" ADD CONSTRAINT "gate_approval_requests_worker_has_engagement"
  CHECK (("kind" = 'worker_off_schedule') = ("engagement_id" IS NOT NULL));
-- Decided means when and how; only a household decision names a person.
ALTER TABLE "gate_approval_requests" ADD CONSTRAINT "gate_approval_requests_decided_matches_status"
  CHECK (("status" = 'pending') = ("decided_at" IS NULL)
     AND ("status" = 'pending') = ("decision_source" IS NULL));
ALTER TABLE "gate_approval_requests" ADD CONSTRAINT "gate_approval_requests_decider_is_household"
  CHECK ("decided_by" IS NULL OR "decision_source" = 'household');
ALTER TABLE "gate_approval_requests" ADD CONSTRAINT "gate_approval_requests_expiry_after_creation"
  CHECK ("expires_at" > "created_at");

-- Never deleted: entries point at them.
REVOKE DELETE ON "gate_approval_requests" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "gate_approval_requests" TO jiwar_app;

ALTER TABLE "gate_approval_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "gate_approval_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "gate_approval_requests"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
