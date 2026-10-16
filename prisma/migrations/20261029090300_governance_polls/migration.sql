-- ============================================================================
-- Phase R7a — the owners' polls (ADR 0051): a question put by the board (or
-- the manager for it), yes / no / abstain or one of 2–10 options, a quorum
-- (a share of the units in the electorate) and a pass threshold (a share of
-- the votes), secret or open: chosen at creation, never changed. Its window,
-- electorate, votes and close are its contest's (20261029090200).
--
-- Until it opens anything but its secrecy may change; once open only a
-- cancel, with a reason; at the close its counts and result, once.
-- ============================================================================

CREATE TYPE "governance_poll_kind" AS ENUM ('yes_no', 'choice');

-- One counter per compound and kind (polls GP-, elections GE-).
CREATE TABLE "governance_counters" (
    "tenant_id" UUID NOT NULL,
    "kind" "governance_contest_kind" NOT NULL,
    "last_number" INTEGER NOT NULL,
    CONSTRAINT "governance_counters_pkey" PRIMARY KEY ("tenant_id", "kind")
);
ALTER TABLE "governance_counters"
  ADD CONSTRAINT "governance_counters_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "governance_counters" ADD CONSTRAINT "governance_counters_last_number"
  CHECK ("last_number" >= 1);

CREATE TABLE "governance_polls" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "contest_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "kind" "governance_poll_kind" NOT NULL,
    "title_en" TEXT,
    "title_ar" TEXT,
    "body_en" TEXT,
    "body_ar" TEXT,
    "quorum_pct" SMALLINT NOT NULL,
    "threshold_pct" SMALLINT NOT NULL,
    -- Who put it: the manager, or a sitting board member.
    "author_side" TEXT NOT NULL,
    "created_by_account_id" UUID NOT NULL,
    -- Written once, at the close.
    "result" TEXT,
    "winning_option_id" UUID,
    "cancel_reason_code" TEXT,
    "cancelled_by_account_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "governance_polls_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "governance_polls_tenant_id_id_key" ON "governance_polls"("tenant_id", "id");
CREATE UNIQUE INDEX "governance_polls_contest_key" ON "governance_polls"("tenant_id", "contest_id");
CREATE UNIQUE INDEX "governance_polls_number_key" ON "governance_polls"("tenant_id", "number");
CREATE INDEX "governance_polls_created_idx" ON "governance_polls"("tenant_id", "created_at", "id");
ALTER TABLE "governance_polls"
  ADD CONSTRAINT "governance_polls_tenant_id_contest_id_fkey"
  FOREIGN KEY ("tenant_id", "contest_id") REFERENCES "governance_contests"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "governance_polls_tenant_id_created_by_fkey"
  FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "governance_polls_tenant_id_cancelled_by_fkey"
  FOREIGN KEY ("tenant_id", "cancelled_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "governance_polls" ADD CONSTRAINT "governance_polls_number_positive"
  CHECK ("number" >= 1);
ALTER TABLE "governance_polls" ADD CONSTRAINT "governance_polls_quorum"
  CHECK ("quorum_pct" BETWEEN 1 AND 100);
ALTER TABLE "governance_polls" ADD CONSTRAINT "governance_polls_threshold"
  CHECK ("threshold_pct" BETWEEN 50 AND 100);
ALTER TABLE "governance_polls" ADD CONSTRAINT "governance_polls_author_side"
  CHECK ("author_side" IN ('manager', 'board'));
-- A language is whole (title and body) or absent, and one is there.
ALTER TABLE "governance_polls" ADD CONSTRAINT "governance_polls_texts"
  CHECK (("title_en" IS NULL) = ("body_en" IS NULL)
     AND ("title_ar" IS NULL) = ("body_ar" IS NULL)
     AND ("title_en" IS NOT NULL OR "title_ar" IS NOT NULL));
ALTER TABLE "governance_polls" ADD CONSTRAINT "governance_polls_text_length"
  CHECK (("title_en" IS NULL OR char_length("title_en") BETWEEN 1 AND 200)
     AND ("title_ar" IS NULL OR char_length("title_ar") BETWEEN 1 AND 200)
     AND ("body_en" IS NULL OR char_length("body_en") BETWEEN 1 AND 4000)
     AND ("body_ar" IS NULL OR char_length("body_ar") BETWEEN 1 AND 4000));
-- A winner only when it passed, on a choice poll.
ALTER TABLE "governance_polls" ADD CONSTRAINT "governance_polls_result"
  CHECK (("result" IS NULL OR "result" IN ('passed', 'failed', 'no_quorum', 'tied'))
     AND ("winning_option_id" IS NULL OR ("result" IS NOT NULL AND "result" = 'passed' AND "kind" = 'choice')));
-- REASON_CODES.governancePollCancel; a unit test keeps the three in step.
ALTER TABLE "governance_polls" ADD CONSTRAINT "governance_polls_cancel"
  CHECK (("cancel_reason_code" IS NULL) = ("cancelled_by_account_id" IS NULL)
     AND ("cancel_reason_code" IS NULL
          OR "cancel_reason_code" IN ('created_in_error', 'superseded', 'board_decision', 'other')));

CREATE TABLE "governance_poll_options" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "poll_id" UUID NOT NULL,
    "position" SMALLINT NOT NULL,
    -- A yes/no poll's options: `yes`, `no`, `abstain`; a choice poll's: none.
    "key" TEXT,
    "label_en" TEXT,
    "label_ar" TEXT,
    -- Written once, at the close.
    "final_count" INTEGER,
    CONSTRAINT "governance_poll_options_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "governance_poll_options_tenant_id_id_key" ON "governance_poll_options"("tenant_id", "id");
CREATE UNIQUE INDEX "governance_poll_options_position_key" ON "governance_poll_options"("tenant_id", "poll_id", "position");
ALTER TABLE "governance_poll_options"
  ADD CONSTRAINT "governance_poll_options_tenant_id_poll_id_fkey"
  FOREIGN KEY ("tenant_id", "poll_id") REFERENCES "governance_polls"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "governance_poll_options" ADD CONSTRAINT "governance_poll_options_shape"
  CHECK ("position" BETWEEN 1 AND 10
     AND ("key" IS NULL OR "key" IN ('yes', 'no', 'abstain'))
     AND ("key" IS NOT NULL OR "label_en" IS NOT NULL OR "label_ar" IS NOT NULL)
     AND ("label_en" IS NULL OR char_length("label_en") BETWEEN 1 AND 200)
     AND ("label_ar" IS NULL OR char_length("label_ar") BETWEEN 1 AND 200)
     AND ("final_count" IS NULL OR "final_count" >= 0));

-- Until its contest opens a poll may change (not its contest, number or
-- author); then only a cancel, once, and the close's result, once. Its
-- options are rewritten before the open only, and counted once.
CREATE FUNCTION governance_poll_moves() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  opened boolean;
BEGIN
  SELECT c."opened_at" IS NOT NULL OR c."cancelled_at" IS NOT NULL INTO opened
    FROM "governance_contests" c
   WHERE c."tenant_id" = OLD."tenant_id" AND c."id" = OLD."contest_id";
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."contest_id" = OLD."contest_id" AND NEW."number" = OLD."number"
     AND NEW."author_side" = OLD."author_side"
     AND NEW."created_by_account_id" = OLD."created_by_account_id"
     AND NEW."created_at" = OLD."created_at"
     AND ((NEW."kind" = OLD."kind"
           AND NEW."title_en" IS NOT DISTINCT FROM OLD."title_en"
           AND NEW."title_ar" IS NOT DISTINCT FROM OLD."title_ar"
           AND NEW."body_en" IS NOT DISTINCT FROM OLD."body_en"
           AND NEW."body_ar" IS NOT DISTINCT FROM OLD."body_ar"
           AND NEW."quorum_pct" = OLD."quorum_pct"
           AND NEW."threshold_pct" = OLD."threshold_pct")
          OR NOT opened)
     AND ((NEW."result" IS NOT DISTINCT FROM OLD."result"
           AND NEW."winning_option_id" IS NOT DISTINCT FROM OLD."winning_option_id")
          OR OLD."result" IS NULL)
     AND ((NEW."cancel_reason_code" IS NOT DISTINCT FROM OLD."cancel_reason_code"
           AND NEW."cancelled_by_account_id" IS NOT DISTINCT FROM OLD."cancelled_by_account_id")
          OR OLD."cancel_reason_code" IS NULL) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'governance_polls: once open, a poll is only cancelled or counted, once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER governance_polls_moves
  BEFORE UPDATE OR DELETE ON "governance_polls"
  FOR EACH ROW EXECUTE FUNCTION governance_poll_moves();
CREATE TRIGGER governance_polls_immutable_truncate
  BEFORE TRUNCATE ON "governance_polls"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

CREATE FUNCTION governance_poll_option_moves() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  r record;
  opened boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN r := NEW; ELSE r := OLD; END IF;
  SELECT c."opened_at" IS NOT NULL OR c."cancelled_at" IS NOT NULL INTO opened
    FROM "governance_polls" p
    JOIN "governance_contests" c ON c."tenant_id" = p."tenant_id" AND c."id" = p."contest_id"
   WHERE p."tenant_id" = r."tenant_id" AND p."id" = r."poll_id";
  IF NOT opened THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."poll_id" = OLD."poll_id" AND NEW."position" = OLD."position"
     AND NEW."key" IS NOT DISTINCT FROM OLD."key"
     AND NEW."label_en" IS NOT DISTINCT FROM OLD."label_en"
     AND NEW."label_ar" IS NOT DISTINCT FROM OLD."label_ar"
     AND (NEW."final_count" IS NOT DISTINCT FROM OLD."final_count"
          OR OLD."final_count" IS NULL) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'governance_poll_options: fixed once the poll opened, but for its count (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER governance_poll_options_moves
  BEFORE INSERT OR UPDATE OR DELETE ON "governance_poll_options"
  FOR EACH ROW EXECUTE FUNCTION governance_poll_option_moves();
CREATE TRIGGER governance_poll_options_immutable_truncate
  BEFORE TRUNCATE ON "governance_poll_options"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Privileges and RLS. Options are deleted while a poll is rewritten before
-- it opens; nothing else is deleted.
-- ----------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['governance_counters', 'governance_polls', 'governance_poll_options'] LOOP
    EXECUTE format('REVOKE ALL ON %I FROM jiwar_app', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON "governance_counters" TO jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "governance_polls" TO jiwar_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "governance_poll_options" TO jiwar_app;
