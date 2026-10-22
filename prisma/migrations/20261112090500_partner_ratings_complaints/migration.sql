-- ============================================================================
-- Phase P1 — ratings and complaints (ADR 0060). A requester rates a request
-- done, once; partners' averages are read from the ratings. A complaint
-- against a partner is a management request on the system topic
-- `partner_service` (ADR 0039 does the conversation, the target, the
-- escalation and the close); its row here links it to the request and holds
-- what the complaint asks — a reason, a compensation, an amount — and the
-- management's decision, once. No money moves here.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Ratings: one per request (the key), 1 to 5, an optional comment. Never
-- changed, but for an erasure clearing the comment, once.
-- ----------------------------------------------------------------------------
CREATE TABLE "partner_ratings" (
    "tenant_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "rater_account_id" UUID NOT NULL,
    "stars" INTEGER NOT NULL,
    "comment" TEXT,
    "comment_cleared_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "partner_ratings_pkey" PRIMARY KEY ("tenant_id", "request_id")
);
CREATE INDEX "partner_ratings_partner_idx"
  ON "partner_ratings"("tenant_id", "partner_id", "created_at" DESC, "request_id");
ALTER TABLE "partner_ratings"
  ADD CONSTRAINT "partner_ratings_request_fkey"
  FOREIGN KEY ("tenant_id", "request_id") REFERENCES "partner_requests"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "partner_ratings_partner_fkey"
  FOREIGN KEY ("tenant_id", "partner_id") REFERENCES "partners"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "partner_ratings_rater_fkey"
  FOREIGN KEY ("tenant_id", "rater_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "partner_ratings" ADD CONSTRAINT "partner_ratings_stars"
  CHECK ("stars" BETWEEN 1 AND 5);
ALTER TABLE "partner_ratings" ADD CONSTRAINT "partner_ratings_comment"
  CHECK (("comment" IS NULL OR char_length("comment") BETWEEN 1 AND 500)
     AND ("comment_cleared_at" IS NULL OR "comment" IS NULL));

CREATE FUNCTION partner_rating_is_kept() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."request_id" = OLD."request_id"
     AND NEW."partner_id" = OLD."partner_id"
     AND NEW."rater_account_id" = OLD."rater_account_id"
     AND NEW."stars" = OLD."stars"
     AND NEW."created_at" = OLD."created_at"
     AND OLD."comment_cleared_at" IS NULL
     AND NEW."comment" IS NULL
     AND NEW."comment_cleared_at" IS NOT NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'partner_ratings: a rating never changes but for its comment cleared once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER partner_ratings_kept
  BEFORE UPDATE OR DELETE ON "partner_ratings"
  FOR EACH ROW EXECUTE FUNCTION partner_rating_is_kept();
CREATE TRIGGER partner_ratings_kept_truncate
  BEFORE TRUNCATE ON "partner_ratings"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Complaints: one per request. What it asks never changes; the decision is
-- written once (outcome, compensation, who, when). The lists are
-- REASON_CODES.partnerComplaint, partnerCompensationAsk and
-- partnerCompensationDecision (a unit test keeps them in step).
-- ----------------------------------------------------------------------------
CREATE TABLE "partner_complaints" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "complainant_account_id" UUID NOT NULL,
    "management_request_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "compensation_ask" TEXT NOT NULL,
    "requested_amount" DECIMAL(10,2),
    "outcome" TEXT,
    "compensation" TEXT,
    "decided_by_account_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "partner_complaints_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "partner_complaints_tenant_id_id_key" ON "partner_complaints"("tenant_id", "id");
CREATE UNIQUE INDEX "partner_complaints_request_key" ON "partner_complaints"("tenant_id", "request_id");
CREATE UNIQUE INDEX "partner_complaints_management_request_key"
  ON "partner_complaints"("tenant_id", "management_request_id");
CREATE INDEX "partner_complaints_queue_idx"
  ON "partner_complaints"("tenant_id", "created_at" DESC, "id");
CREATE INDEX "partner_complaints_partner_idx"
  ON "partner_complaints"("tenant_id", "partner_id", "created_at" DESC);
ALTER TABLE "partner_complaints"
  ADD CONSTRAINT "partner_complaints_request_fkey"
  FOREIGN KEY ("tenant_id", "request_id") REFERENCES "partner_requests"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "partner_complaints_partner_fkey"
  FOREIGN KEY ("tenant_id", "partner_id") REFERENCES "partners"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "partner_complaints_complainant_fkey"
  FOREIGN KEY ("tenant_id", "complainant_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "partner_complaints_management_request_fkey"
  FOREIGN KEY ("tenant_id", "management_request_id") REFERENCES "management_requests"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "partner_complaints_decided_by_fkey"
  FOREIGN KEY ("tenant_id", "decided_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "partner_complaints" ADD CONSTRAINT "partner_complaints_reason"
  CHECK ("reason" IN ('no_show', 'late', 'poor_quality', 'overcharged', 'damage', 'conduct', 'other'));
ALTER TABLE "partner_complaints" ADD CONSTRAINT "partner_complaints_compensation_ask"
  CHECK ("compensation_ask" IN ('none', 'refund', 'redo', 'damages'));
-- An amount only with a refund or damages asked, and then optional.
ALTER TABLE "partner_complaints" ADD CONSTRAINT "partner_complaints_amount"
  CHECK ("requested_amount" IS NULL
      OR ("compensation_ask" IN ('refund', 'damages')
          AND "requested_amount" > 0 AND "requested_amount" <= 999999.99));
ALTER TABLE "partner_complaints" ADD CONSTRAINT "partner_complaints_decision_shape"
  CHECK (("outcome" IS NULL) = ("compensation" IS NULL)
     AND ("outcome" IS NULL) = ("decided_at" IS NULL)
     AND ("outcome" IS NULL) = ("decided_by_account_id" IS NULL));
ALTER TABLE "partner_complaints" ADD CONSTRAINT "partner_complaints_decision"
  CHECK ("outcome" IS NULL
      OR ("outcome" = 'upheld'
          AND "compensation" IN ('none', 'redo', 'partner_refund', 'credit_note'))
      OR ("outcome" = 'not_upheld' AND "compensation" = 'none'));

CREATE FUNCTION partner_complaint_is_kept() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."request_id" = OLD."request_id"
     AND NEW."partner_id" = OLD."partner_id"
     AND NEW."complainant_account_id" = OLD."complainant_account_id"
     AND NEW."management_request_id" = OLD."management_request_id"
     AND NEW."reason" = OLD."reason"
     AND NEW."compensation_ask" = OLD."compensation_ask"
     AND NEW."requested_amount" IS NOT DISTINCT FROM OLD."requested_amount"
     AND NEW."created_at" = OLD."created_at"
     AND OLD."decided_at" IS NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'partner_complaints: a complaint keeps what it asked and is decided once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER partner_complaints_kept
  BEFORE UPDATE OR DELETE ON "partner_complaints"
  FOR EACH ROW EXECUTE FUNCTION partner_complaint_is_kept();
CREATE TRIGGER partner_complaints_kept_truncate
  BEFORE TRUNCATE ON "partner_complaints"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Privileges and RLS. A rating is updated only by an erasure; a complaint's
-- row is locked FOR UPDATE by its decision, which needs UPDATE.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "partner_ratings", "partner_complaints" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "partner_ratings", "partner_complaints" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['partner_ratings', 'partner_complaints'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- Existing compounds: management's system topic (SYSTEM_TOPICS in
-- src/management/settings/defaults.ts; a unit test keeps the two in step).
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    INSERT INTO "management_request_topics" ("id", "tenant_id", "key", "name_ar", "name_en", "target_response_hours", "updated_at")
    SELECT gen_random_uuid(), t, s.key, s.name_ar, s.name_en, s.hours, CURRENT_TIMESTAMP
      FROM (VALUES ('partner_service', 'خدمات مقدمي الخدمة', 'Partner services', 48)) AS s(key, name_ar, name_en, hours)
     WHERE NOT EXISTS (
       SELECT 1 FROM "management_request_topics" m WHERE m."tenant_id" = t AND m."key" = s.key);
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
