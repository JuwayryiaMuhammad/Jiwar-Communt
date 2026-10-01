-- ============================================================================
-- Phase 4 — the gate domain: gates and guard shifts (ADR 0028). A gate is
-- never deleted (entries point at it); deactivating it ends its shifts. A
-- guard acts at the gate only inside an open shift, at most one per guard.
-- ============================================================================

CREATE TYPE "gate_kind" AS ENUM ('pedestrian', 'vehicle', 'mixed');
CREATE TYPE "gate_status" AS ENUM ('active', 'inactive');

CREATE TABLE "gates" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "gate_kind" NOT NULL,
    "status" "gate_status" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "gates_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "gates_tenant_id_name_key" ON "gates"("tenant_id", "name");
CREATE UNIQUE INDEX "gates_tenant_id_id_key" ON "gates"("tenant_id", "id");
ALTER TABLE "gates" ADD CONSTRAINT "gates_name_not_blank"
  CHECK (char_length(btrim("name")) BETWEEN 1 AND 80);

CREATE TABLE "guard_shifts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "guard_account_id" UUID NOT NULL,
    "gate_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ(3),
    "end_reason" TEXT,
    CONSTRAINT "guard_shifts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "guard_shifts_tenant_id_id_key" ON "guard_shifts"("tenant_id", "id");
CREATE UNIQUE INDEX "guard_shifts_one_open_per_guard"
  ON "guard_shifts"("tenant_id", "guard_account_id") WHERE "ended_at" IS NULL;
CREATE INDEX "guard_shifts_tenant_id_gate_id_idx" ON "guard_shifts"("tenant_id", "gate_id");
ALTER TABLE "guard_shifts"
  ADD CONSTRAINT "guard_shifts_tenant_id_guard_account_id_fkey"
  FOREIGN KEY ("tenant_id", "guard_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "guard_shifts_tenant_id_gate_id_fkey"
  FOREIGN KEY ("tenant_id", "gate_id") REFERENCES "gates"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- Ended shifts say when and why; open ones neither.
ALTER TABLE "guard_shifts" ADD CONSTRAINT "guard_shifts_end_is_complete"
  CHECK (("ended_at" IS NULL) = ("end_reason" IS NULL));
ALTER TABLE "guard_shifts" ADD CONSTRAINT "guard_shifts_end_after_start"
  CHECK ("ended_at" IS NULL OR "ended_at" >= "started_at");

-- Never deleted.
REVOKE DELETE ON "gates", "guard_shifts" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "gates", "guard_shifts" TO jiwar_app;

ALTER TABLE "gates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "gates" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "gates"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "guard_shifts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "guard_shifts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "guard_shifts"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
