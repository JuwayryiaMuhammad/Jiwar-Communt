-- ============================================================================
-- The field team, part b (ADR 0090): staff certificates.
-- ============================================================================
--
-- A staff member's certificate: a kind, a title, who issued it and its
-- reference, when it was issued and the day it expires, and the paper
-- itself when filed (`staff_certificate`, a photo or a PDF, through the
-- files service). Kept by the field team. Warn only: its holder and the
-- field team are told 30 days before its expiry and on the day, once each
-- per expiry (`warned_for`, `day_told_for`); an expired certificate blocks
-- nothing. Read into the compliance calendar where it is, never copied.
--
-- Removed once (filed by mistake, or no longer held): its file goes, the
-- row stays. A holder's erasure deletes their certificates with their
-- files.

CREATE TABLE "staff_certificates" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "issuer" TEXT,
    "reference" TEXT,
    "issued_on" DATE,
    "expires_on" DATE NOT NULL,
    "file_id" UUID,
    "warned_for" DATE,
    "day_told_for" DATE,
    "added_by_account_id" UUID NOT NULL,
    "added_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "removed_at" TIMESTAMPTZ(3),
    "removed_by_account_id" UUID,

    CONSTRAINT "staff_certificates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "staff_certificates_tenant_id_id_key"
  ON "staff_certificates" ("tenant_id", "id");
CREATE UNIQUE INDEX "staff_certificates_file_key"
  ON "staff_certificates" ("tenant_id", "file_id");
CREATE INDEX "staff_certificates_holder_idx"
  ON "staff_certificates" ("tenant_id", "account_id", "expires_on");
-- The sweep's and the calendar's: live ones by their expiry.
CREATE INDEX "staff_certificates_expiry_idx"
  ON "staff_certificates" ("tenant_id", "expires_on", "id")
  WHERE "removed_at" IS NULL;

ALTER TABLE "staff_certificates"
  ADD CONSTRAINT "staff_certificates_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "staff_certificates_account_fkey"
    FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "staff_certificates_file_fkey"
    FOREIGN KEY ("tenant_id", "file_id") REFERENCES "files"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "staff_certificates_added_by_fkey"
    FOREIGN KEY ("tenant_id", "added_by_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "staff_certificates_removed_by_fkey"
    FOREIGN KEY ("tenant_id", "removed_by_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  -- STAFF_CERTIFICATE_KINDS (src/maintenance/certificates); a unit test
  -- keeps them in step.
  ADD CONSTRAINT "staff_certificates_kind"
    CHECK ("kind" IN ('electrical', 'plumbing', 'gas', 'hvac', 'working_at_height', 'first_aid', 'fire_safety', 'driving', 'security_licence', 'other')),
  ADD CONSTRAINT "staff_certificates_words"
    CHECK (char_length("title") BETWEEN 1 AND 120
       AND ("issuer" IS NULL OR char_length("issuer") BETWEEN 1 AND 120)
       AND ("reference" IS NULL OR char_length("reference") BETWEEN 1 AND 60)),
  ADD CONSTRAINT "staff_certificates_issued_before_expiry"
    CHECK ("issued_on" IS NULL OR "issued_on" < "expires_on"),
  ADD CONSTRAINT "staff_certificates_removed_shape"
    CHECK (("removed_at" IS NULL) = ("removed_by_account_id" IS NULL)
       AND ("removed_at" IS NULL OR "file_id" IS NULL));

-- A certificate keeps its holder and who added it; a removed one changes
-- no more. Deleted only with its holder's erasure.
CREATE FUNCTION staff_certificate_keeps_holder() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."account_id" = OLD."account_id"
     AND NEW."added_by_account_id" = OLD."added_by_account_id"
     AND NEW."added_at" = OLD."added_at"
     AND OLD."removed_at" IS NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'staff_certificates: a certificate keeps its holder, and a removed one changes no more'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER staff_certificates_keep_holder
  BEFORE UPDATE OR DELETE ON "staff_certificates"
  FOR EACH ROW EXECUTE FUNCTION staff_certificate_keeps_holder();

REVOKE ALL ON "staff_certificates" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "staff_certificates" TO jiwar_app;

ALTER TABLE "staff_certificates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "staff_certificates" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "staff_certificates"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
