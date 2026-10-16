-- ============================================================================
-- Phase R7a — the owners' board (ADR 0051). A board sits for a term; at most
-- one term of a compound is open (not ended) at a time, so two boards never
-- overlap. The manager appoints a board when none sits (the first one, or
-- after a term lapsed); an election's certification seats the next one and
-- ends the term before it (`succeeded`). A term is current while
-- starts_at <= now < ends_at; past its end with no successor it has lapsed,
-- and its members hold nothing until a board is appointed or certified.
--
-- Members are owner accounts with a role: one chair, one secretary, one
-- treasurer at most, and members, within the term's seats. A member's role
-- may change while seated; a seat ends once (resigned, removed, no longer an
-- owner, the account closed). Rows are never deleted.
-- ============================================================================

CREATE TYPE "board_term_source" AS ENUM ('appointed', 'elected');
CREATE TYPE "board_role" AS ENUM ('chair', 'secretary', 'treasurer', 'member');

CREATE TABLE "board_terms" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "source" "board_term_source" NOT NULL,
    -- The election that seated it (its foreign key comes with elections).
    "election_id" UUID,
    "seats" SMALLINT NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "ended_at" TIMESTAMPTZ(3),
    "end_reason" TEXT,
    "created_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "board_terms_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "board_terms_tenant_id_id_key" ON "board_terms"("tenant_id", "id");
-- At most one open term per compound: two boards can never overlap.
CREATE UNIQUE INDEX "board_terms_one_open" ON "board_terms"("tenant_id")
  WHERE "ended_at" IS NULL;
-- An election seats one board.
CREATE UNIQUE INDEX "board_terms_one_per_election" ON "board_terms"("tenant_id", "election_id");
CREATE INDEX "board_terms_history_idx" ON "board_terms"("tenant_id", "starts_at", "id");
ALTER TABLE "board_terms"
  ADD CONSTRAINT "board_terms_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "board_terms_tenant_id_created_by_fkey"
  FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "board_terms" ADD CONSTRAINT "board_terms_period"
  CHECK ("ends_at" > "starts_at");
ALTER TABLE "board_terms" ADD CONSTRAINT "board_terms_seats"
  CHECK ("seats" BETWEEN 3 AND 15);
ALTER TABLE "board_terms" ADD CONSTRAINT "board_terms_source_shape"
  CHECK (("source" = 'elected') = ("election_id" IS NOT NULL));
-- Ended ⇔ why; never before it started. `succeeded`: an election's board
-- took over; `replaced`: the manager appointed one after it lapsed.
ALTER TABLE "board_terms" ADD CONSTRAINT "board_terms_end_shape"
  CHECK (("ended_at" IS NULL) = ("end_reason" IS NULL)
     AND ("ended_at" IS NULL OR "ended_at" >= "starts_at")
     AND ("end_reason" IS NULL OR "end_reason" IN ('succeeded', 'replaced')));

-- A term ends once; nothing else about it ever changes.
CREATE FUNCTION board_term_moves() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."source" = OLD."source"
     AND NEW."election_id" IS NOT DISTINCT FROM OLD."election_id"
     AND NEW."seats" = OLD."seats"
     AND NEW."starts_at" = OLD."starts_at" AND NEW."ends_at" = OLD."ends_at"
     AND NEW."created_by_account_id" = OLD."created_by_account_id"
     AND NEW."created_at" = OLD."created_at"
     AND ((NEW."ended_at" IS NOT DISTINCT FROM OLD."ended_at"
           AND NEW."end_reason" IS NOT DISTINCT FROM OLD."end_reason")
          OR (OLD."ended_at" IS NULL AND NEW."ended_at" IS NOT NULL)) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'board_terms: a term only ends, once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER board_terms_moves
  BEFORE UPDATE OR DELETE ON "board_terms"
  FOR EACH ROW EXECUTE FUNCTION board_term_moves();
CREATE TRIGGER board_terms_immutable_truncate
  BEFORE TRUNCATE ON "board_terms"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

CREATE TABLE "board_members" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "term_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "role" "board_role" NOT NULL,
    "added_at" TIMESTAMPTZ(3) NOT NULL,
    "added_by_account_id" UUID NOT NULL,
    "ended_at" TIMESTAMPTZ(3),
    "end_reason" TEXT,
    -- Null when the system ended it (the account closed, no longer an owner).
    "ended_by_account_id" UUID,
    CONSTRAINT "board_members_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "board_members_tenant_id_id_key" ON "board_members"("tenant_id", "id");
-- One seat per account in a term, one chair, secretary and treasurer.
CREATE UNIQUE INDEX "board_members_one_seat" ON "board_members"("tenant_id", "term_id", "account_id")
  WHERE "ended_at" IS NULL;
CREATE UNIQUE INDEX "board_members_one_office" ON "board_members"("tenant_id", "term_id", "role")
  WHERE "ended_at" IS NULL AND "role" <> 'member';
CREATE INDEX "board_members_term_idx" ON "board_members"("tenant_id", "term_id", "added_at", "id");
-- Whether an account sits now: asked on every board request.
CREATE INDEX "board_members_seated_idx" ON "board_members"("tenant_id", "account_id")
  WHERE "ended_at" IS NULL;
ALTER TABLE "board_members"
  ADD CONSTRAINT "board_members_tenant_id_term_id_fkey"
  FOREIGN KEY ("tenant_id", "term_id") REFERENCES "board_terms"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "board_members_tenant_id_account_id_fkey"
  FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "board_members_tenant_id_added_by_fkey"
  FOREIGN KEY ("tenant_id", "added_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "board_members_tenant_id_ended_by_fkey"
  FOREIGN KEY ("tenant_id", "ended_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- REASON_CODES.boardMemberEnd + REASON_CODES.boardMemberSystemEnd; a unit
-- test keeps the three in step.
ALTER TABLE "board_members" ADD CONSTRAINT "board_members_end_shape"
  CHECK (("ended_at" IS NULL) = ("end_reason" IS NULL)
     AND ("ended_at" IS NOT NULL OR "ended_by_account_id" IS NULL)
     AND ("ended_at" IS NULL OR "ended_at" >= "added_at"));
ALTER TABLE "board_members" ADD CONSTRAINT "board_members_end_reason"
  CHECK ("end_reason" IS NULL
      OR "end_reason" IN ('resigned', 'removed', 'misconduct', 'other', 'no_longer_owner', 'account_closed'));

-- A seat's term and holder never change; its role may, while it lasts; it
-- ends once.
CREATE FUNCTION board_member_moves() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."term_id" = OLD."term_id" AND NEW."account_id" = OLD."account_id"
     AND NEW."added_at" = OLD."added_at"
     AND NEW."added_by_account_id" = OLD."added_by_account_id"
     AND (NEW."role" = OLD."role" OR OLD."ended_at" IS NULL)
     AND ((NEW."ended_at" IS NOT DISTINCT FROM OLD."ended_at"
           AND NEW."end_reason" IS NOT DISTINCT FROM OLD."end_reason"
           AND NEW."ended_by_account_id" IS NOT DISTINCT FROM OLD."ended_by_account_id")
          OR (OLD."ended_at" IS NULL AND NEW."ended_at" IS NOT NULL)) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'board_members: only a seated member''s role, and the end of a seat, once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER board_members_moves
  BEFORE UPDATE OR DELETE ON "board_members"
  FOR EACH ROW EXECUTE FUNCTION board_member_moves();
CREATE TRIGGER board_members_immutable_truncate
  BEFORE TRUNCATE ON "board_members"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Privileges and RLS. Terms end and seats change role or end: UPDATE, never
-- DELETE.
-- ----------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['board_terms', 'board_members'] LOOP
    EXECUTE format('REVOKE ALL ON %I FROM jiwar_app', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO jiwar_app', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
