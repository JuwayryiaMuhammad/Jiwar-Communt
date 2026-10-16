-- ============================================================================
-- Phase R7a — elections of the board (ADR 0051). A nomination window, in
-- which owners stand with a short statement (and may withdraw), then a
-- voting window: a secret contest (20261029090200) where each unit picks up
-- to `seats` candidates. At the close each candidate's count and outcome are
-- written once: the first `seats` with a vote are elected, a tie across the
-- last seat is reported for the board to resolve. The manager certifies it,
-- once, which seats the next board for `term_months` (board_terms gains its
-- foreign key here).
--
-- The candidate list is fixed once voting opens. A candidate's statement is
-- theirs: an erasure clears it, the one change to it ever allowed.
-- ============================================================================

CREATE TYPE "governance_candidate_status" AS ENUM ('nominated', 'withdrawn', 'disqualified');

CREATE TABLE "governance_elections" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "contest_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "title_en" TEXT,
    "title_ar" TEXT,
    "body_en" TEXT,
    "body_ar" TEXT,
    "seats" SMALLINT NOT NULL,
    "term_months" SMALLINT NOT NULL,
    "nominations_open_at" TIMESTAMPTZ(3) NOT NULL,
    "nominations_close_at" TIMESTAMPTZ(3) NOT NULL,
    -- The owners were told nominations opened.
    "nominations_notified_at" TIMESTAMPTZ(3),
    "author_side" TEXT NOT NULL,
    "created_by_account_id" UUID NOT NULL,
    "certified_at" TIMESTAMPTZ(3),
    "certified_by_account_id" UUID,
    "tie_reason_code" TEXT,
    "cancel_reason_code" TEXT,
    -- Null when the system cancelled it (no candidates when voting opened).
    "cancelled_by_account_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "governance_elections_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "governance_elections_tenant_id_id_key" ON "governance_elections"("tenant_id", "id");
CREATE UNIQUE INDEX "governance_elections_contest_key" ON "governance_elections"("tenant_id", "contest_id");
CREATE UNIQUE INDEX "governance_elections_number_key" ON "governance_elections"("tenant_id", "number");
CREATE INDEX "governance_elections_created_idx" ON "governance_elections"("tenant_id", "created_at", "id");
CREATE INDEX "governance_elections_nominations_idx" ON "governance_elections"("tenant_id", "nominations_open_at")
  WHERE "nominations_notified_at" IS NULL;
ALTER TABLE "governance_elections"
  ADD CONSTRAINT "governance_elections_tenant_id_contest_id_fkey"
  FOREIGN KEY ("tenant_id", "contest_id") REFERENCES "governance_contests"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "governance_elections_tenant_id_created_by_fkey"
  FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "governance_elections_tenant_id_certified_by_fkey"
  FOREIGN KEY ("tenant_id", "certified_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "governance_elections_tenant_id_cancelled_by_fkey"
  FOREIGN KEY ("tenant_id", "cancelled_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "governance_elections" ADD CONSTRAINT "governance_elections_number_positive"
  CHECK ("number" >= 1);
ALTER TABLE "governance_elections" ADD CONSTRAINT "governance_elections_seats"
  CHECK ("seats" BETWEEN 3 AND 15);
ALTER TABLE "governance_elections" ADD CONSTRAINT "governance_elections_term"
  CHECK ("term_months" BETWEEN 6 AND 60);
ALTER TABLE "governance_elections" ADD CONSTRAINT "governance_elections_nominations"
  CHECK ("nominations_close_at" > "nominations_open_at");
ALTER TABLE "governance_elections" ADD CONSTRAINT "governance_elections_author_side"
  CHECK ("author_side" IN ('manager', 'board'));
ALTER TABLE "governance_elections" ADD CONSTRAINT "governance_elections_texts"
  CHECK (("title_en" IS NULL) = ("body_en" IS NULL)
     AND ("title_ar" IS NULL) = ("body_ar" IS NULL)
     AND ("title_en" IS NOT NULL OR "title_ar" IS NOT NULL));
ALTER TABLE "governance_elections" ADD CONSTRAINT "governance_elections_text_length"
  CHECK (("title_en" IS NULL OR char_length("title_en") BETWEEN 1 AND 200)
     AND ("title_ar" IS NULL OR char_length("title_ar") BETWEEN 1 AND 200)
     AND ("body_en" IS NULL OR char_length("body_en") BETWEEN 1 AND 4000)
     AND ("body_ar" IS NULL OR char_length("body_ar") BETWEEN 1 AND 4000));
-- Certified ⇔ by whom; a tie's resolution only on a certification.
-- REASON_CODES.governanceTieBreak.
ALTER TABLE "governance_elections" ADD CONSTRAINT "governance_elections_certified"
  CHECK (("certified_at" IS NULL) = ("certified_by_account_id" IS NULL)
     AND ("tie_reason_code" IS NULL
          OR ("certified_at" IS NOT NULL AND "tie_reason_code" IN ('board_decision', 'lot_drawn'))));
-- REASON_CODES.governanceElectionCancel + governanceElectionSystemCancel:
-- the system's alone has no one behind it.
ALTER TABLE "governance_elections" ADD CONSTRAINT "governance_elections_cancel"
  CHECK (("cancelled_by_account_id" IS NULL OR "cancel_reason_code" IS NOT NULL)
     AND ("cancel_reason_code" IS NULL
          OR ("cancel_reason_code" IN ('created_in_error', 'postponed', 'board_decision', 'other')
              AND "cancelled_by_account_id" IS NOT NULL)
          OR ("cancel_reason_code" = 'no_candidates' AND "cancelled_by_account_id" IS NULL)));

-- Until its nominations open an election may change (not its contest,
-- number, seats or author); then a cancel, once, the owners told once, and
-- a certification, once.
CREATE FUNCTION governance_election_moves() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."contest_id" = OLD."contest_id" AND NEW."number" = OLD."number"
     AND NEW."seats" = OLD."seats"
     AND NEW."author_side" = OLD."author_side"
     AND NEW."created_by_account_id" = OLD."created_by_account_id"
     AND NEW."created_at" = OLD."created_at"
     AND ((NEW."title_en" IS NOT DISTINCT FROM OLD."title_en"
           AND NEW."title_ar" IS NOT DISTINCT FROM OLD."title_ar"
           AND NEW."body_en" IS NOT DISTINCT FROM OLD."body_en"
           AND NEW."body_ar" IS NOT DISTINCT FROM OLD."body_ar"
           AND NEW."term_months" = OLD."term_months"
           AND NEW."nominations_open_at" = OLD."nominations_open_at"
           AND NEW."nominations_close_at" = OLD."nominations_close_at")
          OR (OLD."nominations_notified_at" IS NULL AND OLD."cancel_reason_code" IS NULL))
     AND (NEW."nominations_notified_at" IS NOT DISTINCT FROM OLD."nominations_notified_at"
          OR OLD."nominations_notified_at" IS NULL)
     AND ((NEW."certified_at" IS NOT DISTINCT FROM OLD."certified_at"
           AND NEW."certified_by_account_id" IS NOT DISTINCT FROM OLD."certified_by_account_id"
           AND NEW."tie_reason_code" IS NOT DISTINCT FROM OLD."tie_reason_code")
          OR (OLD."certified_at" IS NULL AND OLD."cancel_reason_code" IS NULL))
     AND ((NEW."cancel_reason_code" IS NOT DISTINCT FROM OLD."cancel_reason_code"
           AND NEW."cancelled_by_account_id" IS NOT DISTINCT FROM OLD."cancelled_by_account_id")
          OR (OLD."cancel_reason_code" IS NULL AND OLD."certified_at" IS NULL)) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'governance_elections: once nominations open, an election is only cancelled or certified, once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER governance_elections_moves
  BEFORE UPDATE OR DELETE ON "governance_elections"
  FOR EACH ROW EXECUTE FUNCTION governance_election_moves();
CREATE TRIGGER governance_elections_immutable_truncate
  BEFORE TRUNCATE ON "governance_elections"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- At commit: nominations close before voting opens, and the contest takes
-- as many choices as there are seats.
CREATE FUNCTION governance_election_windows() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  bad integer;
BEGIN
  SELECT count(*) INTO bad
    FROM "governance_elections" e
    JOIN "governance_contests" c ON c."tenant_id" = e."tenant_id" AND c."id" = e."contest_id"
   WHERE e."tenant_id" = NEW."tenant_id"
     AND (CASE WHEN TG_TABLE_NAME = 'governance_elections' THEN e."id" ELSE e."contest_id" END) = NEW."id"
     AND (e."nominations_close_at" > c."opens_at" OR c."max_choices" <> e."seats"
          OR c."kind" <> 'election');
  IF bad > 0 THEN
    RAISE EXCEPTION 'governance_elections %: nominations close before voting opens, one choice per seat', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER governance_elections_windows
  AFTER INSERT OR UPDATE ON "governance_elections" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION governance_election_windows();
CREATE CONSTRAINT TRIGGER governance_contests_election_windows
  AFTER UPDATE ON "governance_contests" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."kind" = 'election')
  EXECUTE FUNCTION governance_election_windows();

-- The board an election seated.
ALTER TABLE "board_terms"
  ADD CONSTRAINT "board_terms_tenant_id_election_id_fkey"
  FOREIGN KEY ("tenant_id", "election_id") REFERENCES "governance_elections"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ----------------------------------------------------------------------------
-- Candidates: an owner standing, once at a time per election.
-- ----------------------------------------------------------------------------
CREATE TABLE "governance_candidates" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "election_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "statement" TEXT,
    "statement_cleared_at" TIMESTAMPTZ(3),
    "status" "governance_candidate_status" NOT NULL DEFAULT 'nominated',
    "nominated_at" TIMESTAMPTZ(3) NOT NULL,
    "ended_at" TIMESTAMPTZ(3),
    -- Withdrawn by the system, or disqualified by the manager.
    "reason_code" TEXT,
    "ended_by_account_id" UUID,
    -- Written once, at the close.
    "final_count" INTEGER,
    "outcome" TEXT,
    CONSTRAINT "governance_candidates_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "governance_candidates_tenant_id_id_key" ON "governance_candidates"("tenant_id", "id");
CREATE UNIQUE INDEX "governance_candidates_one_live" ON "governance_candidates"("tenant_id", "election_id", "account_id")
  WHERE "status" = 'nominated';
CREATE INDEX "governance_candidates_election_idx" ON "governance_candidates"("tenant_id", "election_id", "nominated_at", "id");
CREATE INDEX "governance_candidates_account_idx" ON "governance_candidates"("tenant_id", "account_id");
ALTER TABLE "governance_candidates"
  ADD CONSTRAINT "governance_candidates_tenant_id_election_id_fkey"
  FOREIGN KEY ("tenant_id", "election_id") REFERENCES "governance_elections"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "governance_candidates_tenant_id_account_id_fkey"
  FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "governance_candidates_tenant_id_ended_by_fkey"
  FOREIGN KEY ("tenant_id", "ended_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "governance_candidates" ADD CONSTRAINT "governance_candidates_statement"
  CHECK (("statement" IS NULL OR char_length("statement") BETWEEN 1 AND 500)
     AND ("statement_cleared_at" IS NULL OR "statement" IS NULL));
-- Ended ⇔ not nominated; withdrawn by the candidate (no reason, no one
-- else) or the system (its reason); disqualified by the manager, with one.
-- REASON_CODES.governanceCandidateDisqualify + governanceCandidateSystemWithdraw.
ALTER TABLE "governance_candidates" ADD CONSTRAINT "governance_candidates_end_shape"
  CHECK (("status" = 'nominated') = ("ended_at" IS NULL)
     AND ("status" <> 'nominated' OR ("reason_code" IS NULL AND "ended_by_account_id" IS NULL))
     AND ("status" <> 'withdrawn'
          OR ("ended_by_account_id" IS NULL
              AND ("reason_code" IS NULL OR "reason_code" IN ('no_longer_owner', 'account_closed'))))
     AND ("status" <> 'disqualified'
          OR ("ended_by_account_id" IS NOT NULL
              AND "reason_code" IS NOT NULL
              AND "reason_code" IN ('not_eligible', 'statement_breaks_rules', 'other'))));
ALTER TABLE "governance_candidates" ADD CONSTRAINT "governance_candidates_outcome"
  CHECK (("outcome" IS NULL) = ("final_count" IS NULL)
     AND ("outcome" IS NULL OR "outcome" IN ('elected', 'tied', 'not_elected', 'ineligible'))
     AND ("final_count" IS NULL OR "final_count" >= 0));

-- Its election, holder and nomination never change; it ends once, only
-- before voting opens; its count and outcome are written once (an outcome
-- may move from `elected` or `tied` to `ineligible` or `elected` at the
-- certification); its statement is cleared once.
CREATE FUNCTION governance_candidate_moves() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  r record;
  opened boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN r := NEW; ELSE r := OLD; END IF;
  SELECT c."opened_at" IS NOT NULL OR c."cancelled_at" IS NOT NULL INTO opened
    FROM "governance_elections" e
    JOIN "governance_contests" c ON c."tenant_id" = e."tenant_id" AND c."id" = e."contest_id"
   WHERE e."tenant_id" = r."tenant_id" AND e."id" = r."election_id";
  IF TG_OP = 'INSERT' THEN
    IF opened THEN
      RAISE EXCEPTION 'governance_candidates: the list is fixed once voting opened'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."election_id" = OLD."election_id" AND NEW."account_id" = OLD."account_id"
     AND NEW."nominated_at" = OLD."nominated_at"
     AND ((NEW."status" = OLD."status"
           AND NEW."ended_at" IS NOT DISTINCT FROM OLD."ended_at"
           AND NEW."reason_code" IS NOT DISTINCT FROM OLD."reason_code"
           AND NEW."ended_by_account_id" IS NOT DISTINCT FROM OLD."ended_by_account_id")
          OR (OLD."status" = 'nominated' AND NOT opened))
     AND ((NEW."final_count" IS NOT DISTINCT FROM OLD."final_count"
           AND NEW."outcome" IS NOT DISTINCT FROM OLD."outcome")
          OR (OLD."final_count" IS NULL)
          OR (NEW."final_count" = OLD."final_count"
              AND OLD."outcome" IN ('elected', 'tied')
              AND NEW."outcome" IN ('elected', 'ineligible', 'not_elected')))
     AND ((NEW."statement" IS NOT DISTINCT FROM OLD."statement"
           AND NEW."statement_cleared_at" IS NOT DISTINCT FROM OLD."statement_cleared_at")
          OR (OLD."statement_cleared_at" IS NULL AND NEW."statement_cleared_at" IS NOT NULL
              AND NEW."statement" IS NULL)) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'governance_candidates: a candidacy only ends before voting, is counted once and its statement cleared once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER governance_candidates_moves
  BEFORE INSERT OR UPDATE OR DELETE ON "governance_candidates"
  FOR EACH ROW EXECUTE FUNCTION governance_candidate_moves();
CREATE TRIGGER governance_candidates_immutable_truncate
  BEFORE TRUNCATE ON "governance_candidates"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Privileges and RLS.
-- ----------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['governance_elections', 'governance_candidates'] LOOP
    EXECUTE format('REVOKE ALL ON %I FROM jiwar_app', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO jiwar_app', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
