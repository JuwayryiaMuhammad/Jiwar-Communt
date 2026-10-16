-- ============================================================================
-- Guard shifts and tasks (ADR 0050): instructions to guards.
-- ============================================================================
--
-- The management sends guards instructions — to all of them, a gate or a
-- zone — and every guard it reaches acknowledges each one. The guards it
-- reaches are recorded when it is sent, and anyone who opens a shift where
-- it applies while it is live is added. Archived, never deleted.

CREATE TYPE "guard_instruction_audience" AS ENUM ('all', 'gate', 'zone');
CREATE TYPE "guard_instruction_via" AS ENUM ('send', 'shift_start');

CREATE TABLE "guard_instructions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "urgent" BOOLEAN NOT NULL DEFAULT false,
    "audience" "guard_instruction_audience" NOT NULL,
    "gate_id" UUID,
    "place_id" UUID,
    "created_by_account_id" UUID NOT NULL,
    "archived_at" TIMESTAMPTZ(3),
    "archived_by_account_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "guard_instructions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "guard_instructions_tenant_id_id_key"
  ON "guard_instructions"("tenant_id", "id");
CREATE INDEX "guard_instructions_created_idx"
  ON "guard_instructions"("tenant_id", "created_at", "id");
CREATE INDEX "guard_instructions_live_idx"
  ON "guard_instructions"("tenant_id", "audience")
  WHERE "archived_at" IS NULL;

ALTER TABLE "guard_instructions"
  ADD CONSTRAINT "guard_instructions_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "guard_instructions_tenant_id_gate_id_fkey"
    FOREIGN KEY ("tenant_id", "gate_id") REFERENCES "gates"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "guard_instructions_tenant_id_place_id_fkey"
    FOREIGN KEY ("tenant_id", "place_id") REFERENCES "places"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "guard_instructions_tenant_id_created_by_account_id_fkey"
    FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "guard_instructions_tenant_id_archived_by_account_id_fkey"
    FOREIGN KEY ("tenant_id", "archived_by_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "guard_instructions_title_length"
    CHECK (char_length("title") BETWEEN 1 AND 120),
  ADD CONSTRAINT "guard_instructions_body_length"
    CHECK (char_length("body") BETWEEN 1 AND 4000),
  ADD CONSTRAINT "guard_instructions_audience_shape"
    CHECK (("audience" = 'all' AND "gate_id" IS NULL AND "place_id" IS NULL)
        OR ("audience" = 'gate' AND "gate_id" IS NOT NULL AND "place_id" IS NULL)
        OR ("audience" = 'zone' AND "place_id" IS NOT NULL AND "gate_id" IS NULL)),
  ADD CONSTRAINT "guard_instructions_archive_is_complete"
    CHECK (("archived_at" IS NULL) = ("archived_by_account_id" IS NULL));

-- What was sent, to whom, never changes; it is archived once.
CREATE FUNCTION guard_instruction_is_kept() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."title" = OLD."title"
     AND NEW."body" = OLD."body"
     AND NEW."urgent" = OLD."urgent"
     AND NEW."audience" = OLD."audience"
     AND NEW."gate_id" IS NOT DISTINCT FROM OLD."gate_id"
     AND NEW."place_id" IS NOT DISTINCT FROM OLD."place_id"
     AND NEW."created_by_account_id" = OLD."created_by_account_id"
     AND NEW."created_at" = OLD."created_at"
     AND ((NEW."archived_at" IS NOT DISTINCT FROM OLD."archived_at"
           AND NEW."archived_by_account_id" IS NOT DISTINCT FROM OLD."archived_by_account_id")
          OR OLD."archived_at" IS NULL) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'guard_instructions: an instruction keeps what it says, is archived once and is never deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER guard_instructions_kept
  BEFORE UPDATE OR DELETE ON "guard_instructions"
  FOR EACH ROW EXECUTE FUNCTION guard_instruction_is_kept();
CREATE TRIGGER guard_instructions_kept_truncate
  BEFORE TRUNCATE ON "guard_instructions"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Who it reaches: one row per guard, acknowledged once.
-- ----------------------------------------------------------------------------
CREATE TABLE "guard_instruction_recipients" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "instruction_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "added_via" "guard_instruction_via" NOT NULL,
    "added_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledged_at" TIMESTAMPTZ(3),

    CONSTRAINT "guard_instruction_recipients_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "guard_instruction_recipients_tenant_id_id_key"
  ON "guard_instruction_recipients"("tenant_id", "id");
CREATE UNIQUE INDEX "guard_instruction_recipients_once_key"
  ON "guard_instruction_recipients"("tenant_id", "instruction_id", "account_id");
CREATE INDEX "guard_instruction_recipients_account_idx"
  ON "guard_instruction_recipients"("tenant_id", "account_id", "added_at");
ALTER TABLE "guard_instruction_recipients"
  ADD CONSTRAINT "guard_instruction_recipients_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "guard_instruction_recipients_tenant_id_instruction_id_fkey"
    FOREIGN KEY ("tenant_id", "instruction_id") REFERENCES "guard_instructions"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "guard_instruction_recipients_tenant_id_account_id_fkey"
    FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "guard_instruction_recipients_ack_after_add"
    CHECK ("acknowledged_at" IS NULL OR "acknowledged_at" >= "added_at");

CREATE FUNCTION guard_instruction_recipient_is_kept() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."instruction_id" = OLD."instruction_id"
     AND NEW."account_id" = OLD."account_id"
     AND NEW."added_via" = OLD."added_via"
     AND NEW."added_at" = OLD."added_at"
     AND (NEW."acknowledged_at" IS NOT DISTINCT FROM OLD."acknowledged_at"
          OR OLD."acknowledged_at" IS NULL) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'guard_instruction_recipients: a recipient is acknowledged once and never removed (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER guard_instruction_recipients_kept
  BEFORE UPDATE OR DELETE ON "guard_instruction_recipients"
  FOR EACH ROW EXECUTE FUNCTION guard_instruction_recipient_is_kept();
CREATE TRIGGER guard_instruction_recipients_kept_truncate
  BEFORE TRUNCATE ON "guard_instruction_recipients"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "guard_instructions", "guard_instruction_recipients" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "guard_instructions", "guard_instruction_recipients" TO jiwar_app;

ALTER TABLE "guard_instructions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "guard_instructions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "guard_instructions"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "guard_instruction_recipients" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "guard_instruction_recipients" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "guard_instruction_recipients"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
