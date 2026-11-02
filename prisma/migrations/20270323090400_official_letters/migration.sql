-- ============================================================================
-- Official letters (ADR 0080): a residence confirmation, a no-objection
-- letter or a letter to whom it may concern, issued by the management for a
-- unit's owner or tenant, drawn as a PDF on demand from the record (ADR
-- 0062's certificates) with a code anyone checks on the public page.
--
-- A letter is a record: it never changes, but for its revocation (once) and
-- an erasure clearing the name it was issued to. The name is kept as it was
-- written on the letter, so the PDF is the same each time it is drawn; it is
-- the one personal value here, and an erasure takes it (the letter stays,
-- its check still answers, its PDF is no longer drawn).
-- ============================================================================

CREATE TABLE "official_letter_counters" (
    "tenant_id" UUID NOT NULL,
    "last_number" INTEGER NOT NULL,
    CONSTRAINT "official_letter_counters_pkey" PRIMARY KEY ("tenant_id")
);
ALTER TABLE "official_letter_counters"
  ADD CONSTRAINT "official_letter_counters_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "official_letter_counters" ADD CONSTRAINT "official_letter_counters_positive"
  CHECK ("last_number" >= 1);

CREATE TABLE "official_letters" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "unit_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    -- The request it answers (a `documents` request, ADR 0058), if any.
    "request_id" UUID,
    -- As written on the letter, at its issue; NULL once erased.
    "subject_name" TEXT,
    "erased_at" TIMESTAMPTZ(3),
    -- The place the letter states, as it was at its issue.
    "occupancy_type" "occupancy_type" NOT NULL,
    "occupancy_since" DATE NOT NULL,
    -- Staff's words, printed on the letter: to whom, and about what.
    "addressee" TEXT,
    "subject" TEXT,
    "issued_by_account_id" UUID NOT NULL,
    "issued_at" TIMESTAMPTZ(3) NOT NULL,
    "verify_code" CHAR(22) NOT NULL,
    "template" TEXT NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_by_account_id" UUID,
    "revoke_reason" TEXT,
    CONSTRAINT "official_letters_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "official_letters_tenant_id_id_key" ON "official_letters"("tenant_id", "id");
CREATE UNIQUE INDEX "official_letters_tenant_id_number_key" ON "official_letters"("tenant_id", "number");
CREATE INDEX "official_letters_issued_idx" ON "official_letters"("tenant_id", "issued_at", "id");
CREATE INDEX "official_letters_account_idx" ON "official_letters"("tenant_id", "account_id");
CREATE INDEX "official_letters_unit_idx" ON "official_letters"("tenant_id", "unit_id", "issued_at", "id");
ALTER TABLE "official_letters"
  ADD CONSTRAINT "official_letters_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "official_letters_tenant_id_unit_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "official_letters_tenant_id_account_fkey"
  FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "official_letters_tenant_id_request_fkey"
  FOREIGN KEY ("tenant_id", "request_id") REFERENCES "management_requests"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "official_letters_tenant_id_issued_by_fkey"
  FOREIGN KEY ("tenant_id", "issued_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "official_letters_tenant_id_revoked_by_fkey"
  FOREIGN KEY ("tenant_id", "revoked_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "official_letters" ADD CONSTRAINT "official_letters_number_positive"
  CHECK ("number" >= 1);
ALTER TABLE "official_letters" ADD CONSTRAINT "official_letters_kind_known"
  CHECK ("kind" IN ('residence_confirmation', 'no_objection', 'to_whom_it_may_concern'));
ALTER TABLE "official_letters" ADD CONSTRAINT "official_letters_template_known"
  CHECK ("template" IN ('certificate.v2'));
ALTER TABLE "official_letters" ADD CONSTRAINT "official_letters_verify_code"
  CHECK ("verify_code" ~ '^[A-Za-z0-9_-]{22}$');
-- The name until an erasure, then the time of it; each text bounded.
ALTER TABLE "official_letters" ADD CONSTRAINT "official_letters_text"
  CHECK (("subject_name" IS NULL) = ("erased_at" IS NOT NULL)
     AND ("subject_name" IS NULL OR char_length("subject_name") BETWEEN 1 AND 200)
     AND ("addressee" IS NULL OR char_length("addressee") BETWEEN 1 AND 150)
     AND ("subject" IS NULL OR char_length("subject") BETWEEN 1 AND 300));
-- A no-objection letter says to what.
ALTER TABLE "official_letters" ADD CONSTRAINT "official_letters_no_objection_subject"
  CHECK ("kind" <> 'no_objection' OR "subject" IS NOT NULL);
-- Revoked has its three facts, together, with a code from the list.
ALTER TABLE "official_letters" ADD CONSTRAINT "official_letters_revoked_shape"
  CHECK (("revoked_at" IS NULL) = ("revoked_by_account_id" IS NULL)
     AND ("revoked_at" IS NULL) = ("revoke_reason" IS NULL)
     AND ("revoke_reason" IS NULL
          OR "revoke_reason" IN ('issued_in_error', 'facts_changed', 'replaced', 'other'))
     AND ("revoked_at" IS NULL OR "revoked_at" >= "issued_at"));

-- A letter never changes: one revocation (its three columns from NULL), one
-- erasure (the name to NULL with the time it went), nothing else. No DELETE,
-- no TRUNCATE.
CREATE OR REPLACE FUNCTION official_letter_is_a_record() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'official_letters: a letter is never deleted'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."id" IS NOT DISTINCT FROM OLD."id"
     AND NEW."tenant_id" IS NOT DISTINCT FROM OLD."tenant_id"
     AND NEW."number" IS NOT DISTINCT FROM OLD."number"
     AND NEW."kind" IS NOT DISTINCT FROM OLD."kind"
     AND NEW."unit_id" IS NOT DISTINCT FROM OLD."unit_id"
     AND NEW."account_id" IS NOT DISTINCT FROM OLD."account_id"
     AND NEW."request_id" IS NOT DISTINCT FROM OLD."request_id"
     AND NEW."occupancy_type" IS NOT DISTINCT FROM OLD."occupancy_type"
     AND NEW."occupancy_since" IS NOT DISTINCT FROM OLD."occupancy_since"
     AND NEW."addressee" IS NOT DISTINCT FROM OLD."addressee"
     AND NEW."subject" IS NOT DISTINCT FROM OLD."subject"
     AND NEW."issued_by_account_id" IS NOT DISTINCT FROM OLD."issued_by_account_id"
     AND NEW."issued_at" IS NOT DISTINCT FROM OLD."issued_at"
     AND NEW."verify_code" IS NOT DISTINCT FROM OLD."verify_code"
     AND NEW."template" IS NOT DISTINCT FROM OLD."template"
     -- The name: kept, or cleared once by an erasure.
     AND (NEW."subject_name" IS NOT DISTINCT FROM OLD."subject_name"
          AND NEW."erased_at" IS NOT DISTINCT FROM OLD."erased_at"
          OR OLD."subject_name" IS NOT NULL AND NEW."subject_name" IS NULL
             AND OLD."erased_at" IS NULL AND NEW."erased_at" IS NOT NULL)
     -- The revocation: kept, or made once.
     AND (NEW."revoked_at" IS NOT DISTINCT FROM OLD."revoked_at"
          AND NEW."revoked_by_account_id" IS NOT DISTINCT FROM OLD."revoked_by_account_id"
          AND NEW."revoke_reason" IS NOT DISTINCT FROM OLD."revoke_reason"
          OR OLD."revoked_at" IS NULL) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'official_letters: a letter is a record'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER official_letters_record
  BEFORE UPDATE OR DELETE ON "official_letters"
  FOR EACH ROW EXECUTE FUNCTION official_letter_is_a_record();
CREATE TRIGGER official_letters_record_truncate
  BEFORE TRUNCATE ON "official_letters"
  FOR EACH STATEMENT EXECUTE FUNCTION official_letter_is_a_record();

-- ----------------------------------------------------------------------------
-- The public check's pointer (global, as clearance_links): the code's SHA-256
-- names the compound and the letter before the tenant is known. No PII.
-- ----------------------------------------------------------------------------
CREATE TABLE "official_letter_links" (
    "code_hash" CHAR(64) NOT NULL,
    "tenant_id" UUID NOT NULL,
    "letter_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "official_letter_links_pkey" PRIMARY KEY ("code_hash")
);
ALTER TABLE "official_letter_links"
  ADD CONSTRAINT "official_letter_links_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "official_letter_links_letter_fkey"
  FOREIGN KEY ("tenant_id", "letter_id") REFERENCES "official_letters"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "official_letter_links" ADD CONSTRAINT "official_letter_links_code_hash_hex"
  CHECK ("code_hash" ~ '^[0-9a-f]{64}$');

REVOKE ALL ON "official_letter_counters", "official_letters", "official_letter_links" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "official_letter_counters" TO jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "official_letters" TO jiwar_app;
GRANT SELECT, INSERT ON "official_letter_links" TO jiwar_app;
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['official_letter_counters', 'official_letters'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
