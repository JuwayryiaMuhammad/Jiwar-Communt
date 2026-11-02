-- ============================================================================
-- The office queue (ADR 0080, on ADR 0039 and 0058): a conversation the
-- management starts with a resident, a request turned into a maintenance
-- ticket, and the reply templates staff pick from in the queue.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- `outreach`: the management wrote first. The resident is the author (the
-- one it is with, who reads and answers it) and `opened_by` is the staff
-- member who started it, with no on-behalf reason: the resident made no
-- contact. Fixed at creation.
--
-- `converted_ticket_id`: the ticket the request became. The request closed
-- with `converted` for good: it is never reopened (the CHECK holds the
-- status), the work goes on in the ticket.
-- ----------------------------------------------------------------------------
ALTER TABLE "management_requests"
  ADD COLUMN "outreach" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "converted_ticket_id" UUID;
ALTER TABLE "management_requests"
  ADD CONSTRAINT "management_requests_tenant_id_converted_ticket_fkey"
  FOREIGN KEY ("tenant_id", "converted_ticket_id") REFERENCES "tickets"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE UNIQUE INDEX "management_requests_one_per_ticket"
  ON "management_requests"("tenant_id", "converted_ticket_id")
  WHERE "converted_ticket_id" IS NOT NULL;

-- Opened on behalf: the staff member and the reason code, together; started
-- by the management: the staff member and no reason.
ALTER TABLE "management_requests" DROP CONSTRAINT "management_requests_on_behalf";
ALTER TABLE "management_requests" ADD CONSTRAINT "management_requests_on_behalf"
  CHECK ((("outreach" AND "opened_by_account_id" IS NOT NULL AND "on_behalf_reason" IS NULL)
       OR (NOT "outreach" AND ("opened_by_account_id" IS NULL) = ("on_behalf_reason" IS NULL)))
     AND ("on_behalf_reason" IS NULL OR "on_behalf_reason" IN
           ('resident_phone_call', 'resident_walk_in', 'resident_written_letter')));

-- Closed has its three facts and nothing else has any of them; `converted`
-- is staff's, with its ticket. Every comparison on a nullable column sits
-- beside its IS [NOT] NULL.
ALTER TABLE "management_requests" DROP CONSTRAINT "management_requests_closed_shape";
ALTER TABLE "management_requests" ADD CONSTRAINT "management_requests_closed_shape"
  CHECK (("status" = 'closed') = ("closed_at" IS NOT NULL)
     AND ("closed_at" IS NULL) = ("close_reason" IS NULL)
     AND ("closed_at" IS NULL) = ("closed_by_side" IS NULL)
     AND ("close_reason" IS NULL OR "close_reason" IN
           ('resolved', 'duplicate', 'not_for_management', 'other',
            'auto_closed', 'withdrawn_by_author', 'converted')));
ALTER TABLE "management_requests" ADD CONSTRAINT "management_requests_converted_shape"
  CHECK (("converted_ticket_id" IS NULL)
       = ("close_reason" IS NULL OR "close_reason" <> 'converted')
     AND ("converted_ticket_id" IS NULL OR "status" = 'closed'));

-- Who started it and the ticket it became never change once set.
CREATE OR REPLACE FUNCTION management_request_desk_is_fixed() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."outreach" IS NOT DISTINCT FROM OLD."outreach"
     AND (OLD."converted_ticket_id" IS NULL
          OR NEW."converted_ticket_id" IS NOT DISTINCT FROM OLD."converted_ticket_id") THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'management_requests: an outreach and a conversion never change'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER management_requests_desk_fixed
  BEFORE UPDATE OF "outreach", "converted_ticket_id" ON "management_requests"
  FOR EACH ROW EXECUTE FUNCTION management_request_desk_is_fixed();

-- A unit's requests, for the inbox's unit filter and the unit's correspondence.
CREATE INDEX "management_requests_unit_idx"
  ON "management_requests"("tenant_id", "unit_id", "created_at", "id")
  WHERE "unit_id" IS NOT NULL;

-- ----------------------------------------------------------------------------
-- Reply templates: what staff pick from when they answer in the queue, for
-- one topic or for any (no topic). A name and the words in English, Arabic or
-- both (each at most a message's 4000 characters). Staff's words about nobody: the
-- composer copies one in and edits it; nothing points back at it.
-- ----------------------------------------------------------------------------
CREATE TABLE "request_reply_templates" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "topic_id" UUID,
    "name" TEXT NOT NULL,
    "body_en" TEXT,
    "body_ar" TEXT,
    "created_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "request_reply_templates_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "request_reply_templates_tenant_id_id_key" ON "request_reply_templates"("tenant_id", "id");
CREATE UNIQUE INDEX "request_reply_templates_tenant_id_name_key" ON "request_reply_templates"("tenant_id", "name");
CREATE INDEX "request_reply_templates_topic_idx" ON "request_reply_templates"("tenant_id", "topic_id");
ALTER TABLE "request_reply_templates"
  ADD CONSTRAINT "request_reply_templates_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "request_reply_templates_tenant_id_topic_fkey"
  FOREIGN KEY ("tenant_id", "topic_id") REFERENCES "management_request_topics"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "request_reply_templates_tenant_id_created_by_fkey"
  FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "request_reply_templates" ADD CONSTRAINT "request_reply_templates_text"
  CHECK (char_length("name") BETWEEN 1 AND 80
     AND ("body_en" IS NOT NULL OR "body_ar" IS NOT NULL)
     AND ("body_en" IS NULL OR char_length("body_en") BETWEEN 1 AND 4000)
     AND ("body_ar" IS NULL OR char_length("body_ar") BETWEEN 1 AND 4000));

REVOKE ALL ON "request_reply_templates" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "request_reply_templates" TO jiwar_app;
ALTER TABLE "request_reply_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "request_reply_templates" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "request_reply_templates"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
