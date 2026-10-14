-- ============================================================================
-- Gate card, visitors (ADR 0043): a household's standing instructions.
--
-- A few words about someone who may come without a pass ("my mother, Hoda")
-- and what the guard does with them: always let in, never let in, call the
-- household first, or leave it at the gate. Per unit, written by those who
-- may invite visitors there; the guard sees the words and the action when
-- a visitor for the unit arrives uninvited, and logs the entry as always.
-- The household's gate-instructions (ADR 0028) are untouched: they still
-- decide a request nobody answers.
--
-- Personal data: `description` (free text). It never goes into the audit
-- trail or a notification, an erasure deletes its author's rows, and the
-- author's export lists them. Rows are created and deleted, never updated.
--
-- `tenant_settings.allow_always_allow`: the manager may forbid `always_allow`.
-- While it is off none is created, and the guard sees those that exist as
-- `call_first`.
-- ============================================================================

CREATE TYPE "standing_instruction_action" AS ENUM ('always_allow', 'never_allow', 'call_first', 'leave_at_gate');

CREATE TABLE "unit_standing_instructions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "action" "standing_instruction_action" NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "unit_standing_instructions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "unit_standing_instructions_tenant_id_id_key"
  ON "unit_standing_instructions"("tenant_id", "id");
CREATE INDEX "unit_standing_instructions_unit_idx"
  ON "unit_standing_instructions"("tenant_id", "unit_id", "created_at", "id");
CREATE INDEX "unit_standing_instructions_author_idx"
  ON "unit_standing_instructions"("tenant_id", "created_by");
ALTER TABLE "unit_standing_instructions"
  ADD CONSTRAINT "unit_standing_instructions_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_standing_instructions_tenant_id_unit_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_standing_instructions_tenant_id_created_by_fkey"
  FOREIGN KEY ("tenant_id", "created_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "unit_standing_instructions"
  ADD CONSTRAINT "unit_standing_instructions_description_length"
  CHECK (char_length("description") BETWEEN 1 AND 140);

REVOKE ALL ON "unit_standing_instructions" FROM jiwar_app;
GRANT SELECT, INSERT, DELETE ON "unit_standing_instructions" TO jiwar_app;
ALTER TABLE "unit_standing_instructions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "unit_standing_instructions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "unit_standing_instructions"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "tenant_settings"
  ADD COLUMN "allow_always_allow" BOOLEAN NOT NULL DEFAULT true;
