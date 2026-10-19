-- ============================================================================
-- Board matters (ADR 0055): the board decides by motions. A sitting member
-- proposes one on a matter (an approval request here; appeals to the
-- board join in 20261102090700): the outcome and the reasons, fixed before
-- anyone votes. The members vote for or against, once. It closes once:
-- carried or failed by the count, withdrawn by its proposer (or with its
-- matter), or lapsed when its board stops sitting. One open motion per
-- matter. A matter is decided exactly when a carried motion names it, with
-- the matching outcome (checked at commit).
-- ============================================================================

CREATE TABLE "board_motions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "approval_request_id" UUID,
    "term_id" UUID NOT NULL,
    "proposed_by_member_id" UUID NOT NULL,
    "proposed_by_account_id" UUID NOT NULL,
    "outcome" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "alternatives_note" TEXT,
    "opened_at" TIMESTAMPTZ(3) NOT NULL,
    "closed_at" TIMESTAMPTZ(3),
    "result" TEXT,
    "closed_by_account_id" UUID,
    "votes_for" SMALLINT,
    "votes_against" SMALLINT,
    "sitting" SMALLINT,
    CONSTRAINT "board_motions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "board_motions_tenant_id_id_key" ON "board_motions"("tenant_id", "id");
CREATE UNIQUE INDEX "board_motions_one_open_per_request"
  ON "board_motions"("tenant_id", "approval_request_id")
  WHERE "closed_at" IS NULL AND "approval_request_id" IS NOT NULL;
CREATE INDEX "board_motions_request_idx"
  ON "board_motions"("tenant_id", "approval_request_id", "opened_at", "id");
CREATE INDEX "board_motions_open_idx"
  ON "board_motions"("tenant_id", "term_id") WHERE "closed_at" IS NULL;
ALTER TABLE "board_motions"
  ADD CONSTRAINT "board_motions_tenant_id_request_id_fkey"
  FOREIGN KEY ("tenant_id", "approval_request_id") REFERENCES "governance_approval_requests"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "board_motions_tenant_id_term_id_fkey"
  FOREIGN KEY ("tenant_id", "term_id") REFERENCES "board_terms"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "board_motions_tenant_id_member_id_fkey"
  FOREIGN KEY ("tenant_id", "proposed_by_member_id") REFERENCES "board_members"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "board_motions_tenant_id_proposed_by_fkey"
  FOREIGN KEY ("tenant_id", "proposed_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "board_motions_tenant_id_closed_by_fkey"
  FOREIGN KEY ("tenant_id", "closed_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- One matter; appeals to the board widen it in 20261102090700.
ALTER TABLE "board_motions" ADD CONSTRAINT "board_motions_one_matter"
  CHECK (num_nonnulls("approval_request_id") = 1);
-- A request is approved or rejected; an appeal upheld or overturned.
ALTER TABLE "board_motions" ADD CONSTRAINT "board_motions_outcome"
  CHECK ("outcome" IN ('approve', 'reject', 'uphold', 'overturn')
     AND ("approval_request_id" IS NULL OR "outcome" IN ('approve', 'reject')));
ALTER TABLE "board_motions" ADD CONSTRAINT "board_motions_texts"
  CHECK (char_length("rationale") BETWEEN 1 AND 4000
     AND ("alternatives_note" IS NULL
          OR ("approval_request_id" IS NOT NULL AND char_length("alternatives_note") BETWEEN 1 AND 2000)));
-- Closed once, everything a close says set together: the count for a
-- carried or failed one only; who closed it, for all but the system's
-- lapse. CASE, not `=` on `result IN (…)`, which is NULL while open.
ALTER TABLE "board_motions" ADD CONSTRAINT "board_motions_close_shape"
  CHECK (("closed_at" IS NULL) = ("result" IS NULL)
     AND ("result" IS NULL OR "result" IN ('carried', 'failed', 'withdrawn', 'lapsed'))
     AND CASE WHEN "result" IN ('carried', 'failed')
              THEN "votes_for" IS NOT NULL AND "votes_against" IS NOT NULL AND "sitting" IS NOT NULL
              ELSE "votes_for" IS NULL AND "votes_against" IS NULL AND "sitting" IS NULL END
     AND CASE WHEN "result" IS NULL OR "result" = 'lapsed'
              THEN "closed_by_account_id" IS NULL
              ELSE "closed_by_account_id" IS NOT NULL END
     AND ("votes_for" IS NULL
          OR ("votes_for" >= 0 AND "votes_against" IS NOT NULL AND "votes_against" >= 0
              AND "sitting" IS NOT NULL AND "sitting" >= 1
              AND "votes_for" + "votes_against" <= "sitting"))
     AND ("closed_at" IS NULL OR "closed_at" >= "opened_at"));

-- What was proposed never changes; the close is written once.
CREATE FUNCTION board_motion_moves() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."approval_request_id" IS NOT DISTINCT FROM OLD."approval_request_id"
     AND NEW."term_id" = OLD."term_id"
     AND NEW."proposed_by_member_id" = OLD."proposed_by_member_id"
     AND NEW."proposed_by_account_id" = OLD."proposed_by_account_id"
     AND NEW."outcome" = OLD."outcome"
     AND NEW."rationale" = OLD."rationale"
     AND NEW."alternatives_note" IS NOT DISTINCT FROM OLD."alternatives_note"
     AND NEW."opened_at" = OLD."opened_at"
     AND OLD."closed_at" IS NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'board_motions: a motion keeps what was proposed and closes once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER board_motions_moves
  BEFORE UPDATE OR DELETE ON "board_motions"
  FOR EACH ROW EXECUTE FUNCTION board_motion_moves();
CREATE TRIGGER board_motions_moves_truncate
  BEFORE TRUNCATE ON "board_motions"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- A member's vote on a motion: once, while it is open, never changed. Its
-- account is the member's (the seat's holder), kept for the export.
-- ----------------------------------------------------------------------------
CREATE TABLE "board_votes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "motion_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "choice" TEXT NOT NULL,
    "cast_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "board_votes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "board_votes_tenant_id_id_key" ON "board_votes"("tenant_id", "id");
CREATE UNIQUE INDEX "board_votes_once" ON "board_votes"("tenant_id", "motion_id", "member_id");
CREATE INDEX "board_votes_account_idx" ON "board_votes"("tenant_id", "account_id", "cast_at", "id");
ALTER TABLE "board_votes"
  ADD CONSTRAINT "board_votes_tenant_id_motion_id_fkey"
  FOREIGN KEY ("tenant_id", "motion_id") REFERENCES "board_motions"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "board_votes_tenant_id_member_id_fkey"
  FOREIGN KEY ("tenant_id", "member_id") REFERENCES "board_members"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "board_votes_tenant_id_account_id_fkey"
  FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "board_votes" ADD CONSTRAINT "board_votes_choice"
  CHECK ("choice" IN ('for', 'against'));

-- Only while the motion is open: checked at once, since the vote that
-- decides a motion closes it in the same transaction.
CREATE FUNCTION board_vote_allowed() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "board_motions" m
       WHERE m."tenant_id" = NEW."tenant_id" AND m."id" = NEW."motion_id"
         AND m."closed_at" IS NULL
    ) THEN
      RAISE EXCEPTION 'board_votes: motion % is closed', NEW."motion_id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'board_votes: a vote is never changed (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER board_votes_allowed
  BEFORE INSERT OR UPDATE OR DELETE ON "board_votes"
  FOR EACH ROW EXECUTE FUNCTION board_vote_allowed();
CREATE TRIGGER board_votes_immutable_truncate
  BEFORE TRUNCATE ON "board_votes"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- At commit: a request is approved or rejected exactly when a carried
-- motion names it with the matching outcome, and that motion is the one it
-- names; a carried motion's request is decided by it. Failed, lapsed and
-- withdrawn motions may name a pending (or withdrawn) request.
-- ----------------------------------------------------------------------------
ALTER TABLE "governance_approval_requests"
  ADD CONSTRAINT "governance_approval_requests_tenant_id_motion_id_fkey"
  FOREIGN KEY ("tenant_id", "decided_motion_id") REFERENCES "board_motions"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE UNIQUE INDEX "governance_approval_requests_motion_key"
  ON "governance_approval_requests"("tenant_id", "decided_motion_id")
  WHERE "decided_motion_id" IS NOT NULL;

CREATE FUNCTION governance_approval_decided_by_motion() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  r uuid;
  st text;
  dm uuid;
  carried integer;
  matching integer;
BEGIN
  IF TG_TABLE_NAME = 'governance_approval_requests' THEN
    r := NEW."id";
  ELSE
    r := NEW."approval_request_id";
    IF r IS NULL THEN
      RETURN NULL;
    END IF;
  END IF;
  SELECT x."status", x."decided_motion_id" INTO st, dm
    FROM "governance_approval_requests" x
   WHERE x."tenant_id" = NEW."tenant_id" AND x."id" = r;
  SELECT count(*) INTO carried
    FROM "board_motions" m
   WHERE m."tenant_id" = NEW."tenant_id" AND m."approval_request_id" = r
     AND m."result" = 'carried';
  SELECT count(*) INTO matching
    FROM "board_motions" m
   WHERE m."tenant_id" = NEW."tenant_id" AND m."id" = dm
     AND m."approval_request_id" = r AND m."result" = 'carried'
     AND m."outcome" = CASE st WHEN 'approved' THEN 'approve' WHEN 'rejected' THEN 'reject' END;
  IF (st IN ('approved', 'rejected')) <> (carried = 1 AND matching = 1)
     OR (st NOT IN ('approved', 'rejected') AND carried <> 0) THEN
    RAISE EXCEPTION 'governance approval request %: decided (%) exactly by one carried motion with its outcome (% carried, % matching)', r, st, carried, matching
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER governance_approval_requests_decided
  AFTER UPDATE OF "status" ON "governance_approval_requests" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (OLD."status" IS DISTINCT FROM NEW."status")
  EXECUTE FUNCTION governance_approval_decided_by_motion();
CREATE CONSTRAINT TRIGGER board_motions_carried_request
  AFTER UPDATE OF "result" ON "board_motions" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."result" = 'carried')
  EXECUTE FUNCTION governance_approval_decided_by_motion();

REVOKE ALL ON "board_motions", "board_votes" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "board_motions" TO jiwar_app;
GRANT SELECT, INSERT ON "board_votes" TO jiwar_app;
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['board_motions', 'board_votes'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
