-- ============================================================================
-- Phase R7a — the voting core shared by polls and elections (ADR 0051).
--
-- A contest opens with a snapshot of its electorate: one elector per unit,
-- the account that casts the unit's one vote. A unit takes part once
-- (`governance_participations`, its primary key), by its elector, while the
-- contest is open; nobody changes a vote.
--
-- An open contest stores the choice with the unit, on the participation. A
-- secret one never does: the composite key (contest, secret) and a CHECK
-- make a choice next to a unit impossible. Its ballots live in one row per
-- contest while voting is open (`governance_ballot_boxes`: a JSON object
-- from a random v4 id to the choice), rewritten whole by every vote, so no
-- ballot has a system column of its own: a row per ballot would share its
-- `xmin` with the participation and the audit entry written in the same
-- transaction, and its `ctid` would give the order of voting. JSON object
-- keys are stored sorted, not in the order they came. At the close the
-- ballots are written as rows (`governance_ballots`: a random id, the
-- contest, the choice; nothing else) in one statement, in id order, and the
-- box is deleted: every ballot row has the close's `xmin`, and their order
-- is their random ids'.
--
-- At every commit, a secret contest's ballots (in its box, or once closed in
-- its rows) are exactly as many as its participations; no ballot already
-- cast ever changes.
-- ============================================================================

CREATE TYPE "governance_contest_kind" AS ENUM ('poll', 'election');

CREATE TABLE "governance_contests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" "governance_contest_kind" NOT NULL,
    "secret" BOOLEAN NOT NULL,
    -- How many choices a ballot takes at most: 1 for a poll, the seats for
    -- an election.
    "max_choices" SMALLINT NOT NULL,
    "opens_at" TIMESTAMPTZ(3) NOT NULL,
    "closes_at" TIMESTAMPTZ(3) NOT NULL,
    -- The electorate's snapshot was taken.
    "opened_at" TIMESTAMPTZ(3),
    "electorate" INTEGER,
    "closed_at" TIMESTAMPTZ(3),
    "turnout" INTEGER,
    "cancelled_at" TIMESTAMPTZ(3),
    -- The 24-hour reminder went out.
    "reminded_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "governance_contests_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "governance_contests_tenant_id_id_key" ON "governance_contests"("tenant_id", "id");
-- What a participation's and a box's composite keys point at: a choice
-- next to a unit, or a box, exists only where `secret` says so.
CREATE UNIQUE INDEX "governance_contests_tenant_id_id_secret_key" ON "governance_contests"("tenant_id", "id", "secret");
-- The sweeps: due to open, due to close, due to be reminded.
CREATE INDEX "governance_contests_opens_idx" ON "governance_contests"("tenant_id", "opens_at")
  WHERE "opened_at" IS NULL AND "cancelled_at" IS NULL;
CREATE INDEX "governance_contests_closes_idx" ON "governance_contests"("tenant_id", "closes_at")
  WHERE "closed_at" IS NULL AND "cancelled_at" IS NULL;
ALTER TABLE "governance_contests"
  ADD CONSTRAINT "governance_contests_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "governance_contests" ADD CONSTRAINT "governance_contests_window"
  CHECK ("closes_at" > "opens_at");
ALTER TABLE "governance_contests" ADD CONSTRAINT "governance_contests_max_choices"
  CHECK ("max_choices" BETWEEN 1 AND 15);
-- An election is always secret.
ALTER TABLE "governance_contests" ADD CONSTRAINT "governance_contests_election_secret"
  CHECK ("kind" = 'poll' OR "secret");
-- Opened ⇔ its electorate counted; closed ⇔ its turnout, and only once
-- opened; never both closed and cancelled.
ALTER TABLE "governance_contests" ADD CONSTRAINT "governance_contests_state_shape"
  CHECK (("opened_at" IS NULL) = ("electorate" IS NULL)
     AND ("closed_at" IS NULL) = ("turnout" IS NULL)
     AND ("closed_at" IS NULL OR "opened_at" IS NOT NULL)
     AND ("closed_at" IS NULL OR "cancelled_at" IS NULL)
     AND ("reminded_at" IS NULL OR "opened_at" IS NOT NULL));
ALTER TABLE "governance_contests" ADD CONSTRAINT "governance_contests_counts"
  CHECK (("electorate" IS NULL OR "electorate" >= 0)
     AND ("turnout" IS NULL OR ("turnout" >= 0 AND "turnout" <= "electorate")));

-- A contest moves forward only: its window may change until it opens; it
-- opens once, closes or is cancelled once, is reminded once. Its kind,
-- secrecy and choices never change.
CREATE FUNCTION governance_contest_moves() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."kind" = OLD."kind" AND NEW."secret" = OLD."secret"
     AND NEW."max_choices" = OLD."max_choices"
     AND NEW."created_at" = OLD."created_at"
     AND ((NEW."opens_at" = OLD."opens_at" AND NEW."closes_at" = OLD."closes_at")
          OR (OLD."opened_at" IS NULL AND OLD."cancelled_at" IS NULL))
     AND ((NEW."opened_at" IS NOT DISTINCT FROM OLD."opened_at"
           AND NEW."electorate" IS NOT DISTINCT FROM OLD."electorate")
          OR (OLD."opened_at" IS NULL AND OLD."cancelled_at" IS NULL))
     AND ((NEW."closed_at" IS NOT DISTINCT FROM OLD."closed_at"
           AND NEW."turnout" IS NOT DISTINCT FROM OLD."turnout")
          OR (OLD."closed_at" IS NULL AND OLD."cancelled_at" IS NULL))
     AND (NEW."cancelled_at" IS NOT DISTINCT FROM OLD."cancelled_at"
          OR (OLD."cancelled_at" IS NULL AND OLD."closed_at" IS NULL))
     AND (NEW."reminded_at" IS NOT DISTINCT FROM OLD."reminded_at"
          OR OLD."reminded_at" IS NULL) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'governance_contests: a contest only opens, closes or is cancelled, once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER governance_contests_moves
  BEFORE UPDATE OR DELETE ON "governance_contests"
  FOR EACH ROW EXECUTE FUNCTION governance_contest_moves();
CREATE TRIGGER governance_contests_immutable_truncate
  BEFORE TRUNCATE ON "governance_contests"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- The electorate, snapshotted when the contest opens: never after.
-- ----------------------------------------------------------------------------
CREATE TABLE "governance_electors" (
    "tenant_id" UUID NOT NULL,
    "contest_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    CONSTRAINT "governance_electors_pkey" PRIMARY KEY ("tenant_id", "contest_id", "unit_id")
);
CREATE INDEX "governance_electors_account_idx" ON "governance_electors"("tenant_id", "account_id");
ALTER TABLE "governance_electors"
  ADD CONSTRAINT "governance_electors_tenant_id_contest_id_fkey"
  FOREIGN KEY ("tenant_id", "contest_id") REFERENCES "governance_contests"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "governance_electors_tenant_id_unit_id_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "governance_electors_tenant_id_account_id_fkey"
  FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION governance_elector_before_open() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "governance_contests" c
              WHERE c."tenant_id" = NEW."tenant_id" AND c."id" = NEW."contest_id"
                AND (c."opened_at" IS NOT NULL OR c."cancelled_at" IS NOT NULL)) THEN
    RAISE EXCEPTION 'governance_electors: the electorate is fixed once the contest opened'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER governance_electors_before_open
  BEFORE INSERT ON "governance_electors"
  FOR EACH ROW EXECUTE FUNCTION governance_elector_before_open();
CREATE TRIGGER governance_electors_immutable_rows
  BEFORE UPDATE OR DELETE ON "governance_electors"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER governance_electors_immutable_truncate
  BEFORE TRUNCATE ON "governance_electors"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Who voted for which unit, and when: once per unit. The choice only on an
-- open contest.
-- ----------------------------------------------------------------------------
CREATE TABLE "governance_participations" (
    "tenant_id" UUID NOT NULL,
    "contest_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "voter_account_id" UUID NOT NULL,
    "voted_at" TIMESTAMPTZ(3) NOT NULL,
    "secret" BOOLEAN NOT NULL,
    "choice" UUID[],
    CONSTRAINT "governance_participations_pkey" PRIMARY KEY ("tenant_id", "contest_id", "unit_id")
);
CREATE INDEX "governance_participations_voter_idx" ON "governance_participations"("tenant_id", "voter_account_id");
ALTER TABLE "governance_participations"
  ADD CONSTRAINT "governance_participations_contest_fkey"
  FOREIGN KEY ("tenant_id", "contest_id", "secret") REFERENCES "governance_contests"("tenant_id", "id", "secret")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "governance_participations_elector_fkey"
  FOREIGN KEY ("tenant_id", "contest_id", "unit_id") REFERENCES "governance_electors"("tenant_id", "contest_id", "unit_id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "governance_participations_tenant_id_voter_fkey"
  FOREIGN KEY ("tenant_id", "voter_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- A secret contest's participation never holds a choice; an open one's does.
ALTER TABLE "governance_participations" ADD CONSTRAINT "governance_participations_choice_shape"
  CHECK ("secret" = ("choice" IS NULL)
     AND ("choice" IS NULL OR cardinality("choice") BETWEEN 1 AND 15));

-- A unit votes by its elector, while the contest is open.
CREATE FUNCTION governance_participation_allowed() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM "governance_contests" c
         JOIN "governance_electors" e
           ON e."tenant_id" = c."tenant_id" AND e."contest_id" = c."id"
        WHERE c."tenant_id" = NEW."tenant_id" AND c."id" = NEW."contest_id"
          AND e."unit_id" = NEW."unit_id"
          AND e."account_id" = NEW."voter_account_id"
          AND c."opened_at" IS NOT NULL
          AND c."closed_at" IS NULL AND c."cancelled_at" IS NULL) THEN
    RAISE EXCEPTION 'governance_participations: a unit votes by its elector, while the contest is open'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER governance_participations_allowed
  BEFORE INSERT ON "governance_participations"
  FOR EACH ROW EXECUTE FUNCTION governance_participation_allowed();
CREATE TRIGGER governance_participations_immutable_rows
  BEFORE UPDATE OR DELETE ON "governance_participations"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER governance_participations_immutable_truncate
  BEFORE TRUNCATE ON "governance_participations"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- A secret contest's ballots while voting is open: one row, rewritten whole.
-- ----------------------------------------------------------------------------
CREATE TABLE "governance_ballot_boxes" (
    "tenant_id" UUID NOT NULL,
    "contest_id" UUID NOT NULL,
    -- Always true: a box exists for a secret contest only (its key).
    "secret" BOOLEAN NOT NULL DEFAULT true,
    "ballots" JSONB NOT NULL DEFAULT '{}',
    CONSTRAINT "governance_ballot_boxes_pkey" PRIMARY KEY ("tenant_id", "contest_id")
);
ALTER TABLE "governance_ballot_boxes"
  ADD CONSTRAINT "governance_ballot_boxes_contest_fkey"
  FOREIGN KEY ("tenant_id", "contest_id", "secret") REFERENCES "governance_contests"("tenant_id", "id", "secret")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "governance_ballot_boxes" ADD CONSTRAINT "governance_ballot_boxes_secret"
  CHECK ("secret");
ALTER TABLE "governance_ballot_boxes" ADD CONSTRAINT "governance_ballot_boxes_shape"
  CHECK (jsonb_typeof("ballots") = 'object');

-- A ballot is added while the contest is open, never changed or taken out;
-- the box goes once the contest is closed or cancelled.
CREATE FUNCTION governance_ballot_box_moves() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  live boolean;
BEGIN
  SELECT c."opened_at" IS NOT NULL AND c."closed_at" IS NULL AND c."cancelled_at" IS NULL
    INTO live
    FROM "governance_contests" c
   WHERE c."tenant_id" = OLD."tenant_id" AND c."id" = OLD."contest_id";
  IF TG_OP = 'DELETE' THEN
    IF NOT live THEN
      RETURN OLD;
    END IF;
  ELSIF live
     AND NEW."tenant_id" = OLD."tenant_id" AND NEW."contest_id" = OLD."contest_id"
     AND NEW."secret" = OLD."secret"
     AND NOT EXISTS (SELECT 1 FROM jsonb_each(OLD."ballots") o
                      WHERE NEW."ballots" -> o.key IS DISTINCT FROM o.value) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'governance_ballot_boxes: ballots are only added while the contest is open, and the box goes at its end (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER governance_ballot_boxes_moves
  BEFORE UPDATE OR DELETE ON "governance_ballot_boxes"
  FOR EACH ROW EXECUTE FUNCTION governance_ballot_box_moves();
CREATE TRIGGER governance_ballot_boxes_immutable_truncate
  BEFORE TRUNCATE ON "governance_ballot_boxes"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- A closed secret contest's ballots: a random id, the contest, the choice.
-- ----------------------------------------------------------------------------
CREATE TABLE "governance_ballots" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "contest_id" UUID NOT NULL,
    "choice" UUID[] NOT NULL,
    CONSTRAINT "governance_ballots_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "governance_ballots_contest_idx" ON "governance_ballots"("tenant_id", "contest_id");
ALTER TABLE "governance_ballots"
  ADD CONSTRAINT "governance_ballots_tenant_id_contest_id_fkey"
  FOREIGN KEY ("tenant_id", "contest_id") REFERENCES "governance_contests"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- A random v4 id: never the time-ordered ids of the rest of the schema.
ALTER TABLE "governance_ballots" ADD CONSTRAINT "governance_ballots_random_id"
  CHECK (substr("id"::text, 15, 1) = '4');
ALTER TABLE "governance_ballots" ADD CONSTRAINT "governance_ballots_choice"
  CHECK (cardinality("choice") BETWEEN 1 AND 15);

-- Written once, when the secret contest closes.
CREATE FUNCTION governance_ballot_at_close() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "governance_contests" c
                  WHERE c."tenant_id" = NEW."tenant_id" AND c."id" = NEW."contest_id"
                    AND c."secret" AND c."closed_at" IS NOT NULL) THEN
    RAISE EXCEPTION 'governance_ballots: written when a secret contest closes'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER governance_ballots_at_close
  BEFORE INSERT ON "governance_ballots"
  FOR EACH ROW EXECUTE FUNCTION governance_ballot_at_close();
CREATE TRIGGER governance_ballots_immutable_rows
  BEFORE UPDATE OR DELETE ON "governance_ballots"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER governance_ballots_immutable_truncate
  BEFORE TRUNCATE ON "governance_ballots"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- At commit: a secret contest holds exactly one ballot per participation —
-- in its box while voting is open, in its rows once closed, none once
-- cancelled (its participations stay: they say who took part).
-- ----------------------------------------------------------------------------
CREATE FUNCTION governance_ballots_match() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  t uuid;
  k uuid;
  is_secret boolean;
  is_closed boolean;
  is_cancelled boolean;
  voted integer;
  boxed integer;
  has_box boolean;
  rows_ integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    t := OLD."tenant_id"; k := OLD."contest_id";
  ELSIF TG_TABLE_NAME = 'governance_contests' THEN
    t := NEW."tenant_id"; k := NEW."id";
  ELSE
    t := NEW."tenant_id"; k := NEW."contest_id";
  END IF;
  SELECT c."secret", c."closed_at" IS NOT NULL, c."cancelled_at" IS NOT NULL
    INTO is_secret, is_closed, is_cancelled
    FROM "governance_contests" c WHERE c."tenant_id" = t AND c."id" = k;
  IF NOT is_secret THEN
    RETURN NULL;
  END IF;
  SELECT count(*) INTO voted FROM "governance_participations" p
   WHERE p."tenant_id" = t AND p."contest_id" = k;
  SELECT count(*) > 0 INTO has_box
    FROM "governance_ballot_boxes" b WHERE b."tenant_id" = t AND b."contest_id" = k;
  SELECT count(*) INTO boxed
    FROM "governance_ballot_boxes" b, jsonb_object_keys(b."ballots") AS j(key)
   WHERE b."tenant_id" = t AND b."contest_id" = k;
  SELECT count(*) INTO rows_ FROM "governance_ballots" g
   WHERE g."tenant_id" = t AND g."contest_id" = k;
  IF (has_box AND (is_closed OR is_cancelled OR boxed <> voted OR rows_ <> 0))
     OR (NOT has_box AND is_closed AND rows_ <> voted)
     OR (NOT has_box AND is_cancelled AND rows_ <> 0)
     OR (NOT has_box AND NOT is_closed AND NOT is_cancelled AND (voted <> 0 OR rows_ <> 0)) THEN
    RAISE EXCEPTION 'contest %: % participations, % ballots in a box, % ballot rows', k, voted, boxed, rows_
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER governance_participations_ballots_match
  AFTER INSERT ON "governance_participations" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION governance_ballots_match();
CREATE CONSTRAINT TRIGGER governance_ballot_boxes_ballots_match
  AFTER INSERT OR UPDATE OR DELETE ON "governance_ballot_boxes" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION governance_ballots_match();
CREATE CONSTRAINT TRIGGER governance_ballots_ballots_match
  AFTER INSERT ON "governance_ballots" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION governance_ballots_match();
CREATE CONSTRAINT TRIGGER governance_contests_ballots_match
  AFTER UPDATE ON "governance_contests" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION governance_ballots_match();

-- ----------------------------------------------------------------------------
-- Privileges and RLS. Electors, participations and ballots are written
-- once; a box is rewritten and deleted; a contest moves forward.
-- ----------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['governance_contests', 'governance_electors',
                           'governance_participations', 'governance_ballot_boxes',
                           'governance_ballots'] LOOP
    EXECUTE format('REVOKE ALL ON %I FROM jiwar_app', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON "governance_contests" TO jiwar_app;
GRANT SELECT, INSERT ON "governance_electors" TO jiwar_app;
GRANT SELECT, INSERT ON "governance_participations" TO jiwar_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "governance_ballot_boxes" TO jiwar_app;
GRANT SELECT, INSERT ON "governance_ballots" TO jiwar_app;
