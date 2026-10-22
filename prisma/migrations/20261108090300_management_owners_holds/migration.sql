-- ============================================================================
-- Talking to the management (ADR 0058, on ADR 0039).
--
-- A topic names the role that owns it (a role, never a person): residents
-- see it, and an unassigned request of the topic goes to that role's
-- handlers. A request may be about something held (a ticket on hold, a
-- stopped work permit, the unit's credit awaiting a refund): it records
-- what and the hold's reason as it was, and one live request per held item.
-- The release topic is seeded in every compound.
-- ============================================================================

ALTER TABLE "management_request_topics" ADD COLUMN "owner_role_id" UUID;
ALTER TABLE "management_request_topics"
  ADD CONSTRAINT "management_request_topics_owner_role_fkey"
  FOREIGN KEY ("tenant_id", "owner_role_id") REFERENCES "roles"("tenant_id", "id")
  ON DELETE SET NULL ("owner_role_id") ON UPDATE RESTRICT;

ALTER TABLE "management_requests"
  ADD COLUMN "about_type" TEXT,
  ADD COLUMN "about_id" UUID,
  ADD COLUMN "about_reason" TEXT;
ALTER TABLE "management_requests"
  ADD CONSTRAINT "management_requests_about_shape"
    CHECK (("about_type" IS NULL) = ("about_id" IS NULL)
       AND ("about_type" IS NULL) = ("about_reason" IS NULL)),
  ADD CONSTRAINT "management_requests_about_type_known"
    CHECK ("about_type" IS NULL
        OR "about_type" IN ('maintenance', 'unit_permit', 'unit_credit'));
-- One live request per held item; a closed one leaves room for the next.
CREATE UNIQUE INDEX "management_requests_one_live_about"
  ON "management_requests"("tenant_id", "about_type", "about_id")
  WHERE "about_type" IS NOT NULL AND "status" <> 'closed';

-- What a request is about never changes.
CREATE OR REPLACE FUNCTION management_request_about_is_fixed() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."about_type" IS NOT DISTINCT FROM OLD."about_type"
     AND NEW."about_id" IS NOT DISTINCT FROM OLD."about_id"
     AND NEW."about_reason" IS NOT DISTINCT FROM OLD."about_reason" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'management_requests: what a request is about never changes'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER management_requests_about_fixed
  BEFORE UPDATE OF "about_type", "about_id", "about_reason" ON "management_requests"
  FOR EACH ROW EXECUTE FUNCTION management_request_about_is_fixed();

-- The release topic in every existing compound (new ones get it from the
-- provisioning).
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', t."id"::text, true);
    INSERT INTO "management_request_topics"
      ("id", "tenant_id", "key", "name_ar", "name_en", "target_response_hours", "updated_at")
    VALUES (gen_random_uuid(), t."id", 'release_request', 'طلب رفع تعليق', 'Release a hold', 48, CURRENT_TIMESTAMP)
    ON CONFLICT DO NOTHING;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
