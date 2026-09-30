-- A CHECK passes when its expression is NULL. The previous minor branch
-- compared id_document_type and nationality, which are NULL-able here, so a
-- minor with neither passed. Every term is now a plain boolean.
ALTER TABLE "household_members" DROP CONSTRAINT "household_members_minor_or_account";
ALTER TABLE "household_members" ADD CONSTRAINT "household_members_minor_or_account"
  CHECK (
    ("is_minor" AND "account_id" IS NULL AND "full_name" IS NOT NULL
      AND "id_document_number" IS NOT NULL
      AND "id_document_type" IS NOT NULL AND "nationality" IS NOT NULL
      AND COALESCE(
            ("id_document_type" = 'national_id' AND "nationality" = 'EG')
         OR ("id_document_type" = 'passport' AND "nationality" ~ '^[A-Z]{2}$'),
            false))
    OR
    (NOT "is_minor" AND "account_id" IS NOT NULL AND "full_name" IS NULL
      AND "id_document_number" IS NULL AND "id_document_type" IS NULL
      AND "nationality" IS NULL)
  );
