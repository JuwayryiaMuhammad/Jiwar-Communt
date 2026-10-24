-- ============================================================================
-- Building representatives (ADR 0059): the board names an owner of a unit
-- in a building its representative, one at a time per building, from a
-- day; the board ends it, or it ends when they no longer own a unit there
-- or their account closes. The building's residents see their first name
-- and since when; they write to them privately.
--
-- Naming or ending one is a board decision (ADR 0055's motions): a sitting
-- member raises the matter, the board decides it by a carried motion, and
-- the term records the matter that named it and the one that ended it.
--
-- A thread is one resident's with one representative: their unit then
-- (its code is what the representative sees, with the first name), the
-- time of its last message. Its messages are append-only; a writer's
-- erasure clears their words, once (ADR 0039).
-- ============================================================================

CREATE TABLE "governance_representatives" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "building" TEXT NOT NULL,
    "account_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "appointed_at" TIMESTAMPTZ(3) NOT NULL,
    "appointed_by_matter_id" UUID NOT NULL,
    "ended_at" TIMESTAMPTZ(3),
    "ended_by_matter_id" UUID,
    "end_reason" TEXT,
    CONSTRAINT "governance_representatives_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "governance_representatives_tenant_id_id_key"
  ON "governance_representatives"("tenant_id", "id");
-- One representative of a building at a time.
CREATE UNIQUE INDEX "governance_representatives_one_active"
  ON "governance_representatives"("tenant_id", "building")
  WHERE "ended_at" IS NULL;
CREATE INDEX "governance_representatives_account_idx"
  ON "governance_representatives"("tenant_id", "account_id", "appointed_at");
ALTER TABLE "governance_representatives"
  ADD CONSTRAINT "governance_representatives_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "governance_representatives_tenant_id_unit_id_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "governance_representatives_tenant_id_account_fkey"
  FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "governance_representatives" ADD CONSTRAINT "governance_representatives_building"
  CHECK (char_length("building") BETWEEN 1 AND 100);
-- REPRESENTATIVE_END_REASONS; the board's matter ends it (`ended`, or
-- `replaced` by the matter naming the next), the system the rest. A unit
-- test keeps them in step.
ALTER TABLE "governance_representatives" ADD CONSTRAINT "governance_representatives_end_shape"
  CHECK (("ended_at" IS NULL) = ("end_reason" IS NULL)
     AND ("ended_at" IS NULL OR "ended_at" >= "appointed_at")
     AND ("end_reason" IS NULL
          OR ("end_reason" IN ('ended', 'replaced') AND "ended_by_matter_id" IS NOT NULL)
          OR ("end_reason" IN ('no_longer_owner', 'account_closed') AND "ended_by_matter_id" IS NULL)));

-- Kept as appointed; ended once.
CREATE FUNCTION governance_representative_ends_once() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."building" = OLD."building" AND NEW."account_id" = OLD."account_id"
     AND NEW."unit_id" = OLD."unit_id"
     AND NEW."appointed_at" = OLD."appointed_at"
     AND NEW."appointed_by_matter_id" = OLD."appointed_by_matter_id"
     AND OLD."ended_at" IS NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'governance_representatives: kept as appointed, ended once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER governance_representatives_ends_once
  BEFORE UPDATE OR DELETE ON "governance_representatives"
  FOR EACH ROW EXECUTE FUNCTION governance_representative_ends_once();
CREATE TRIGGER governance_representatives_ends_once_truncate
  BEFORE TRUNCATE ON "governance_representatives"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

CREATE TABLE "representative_threads" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "representative_id" UUID NOT NULL,
    "writer_account_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "last_message_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "representative_threads_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "representative_threads_tenant_id_id_key"
  ON "representative_threads"("tenant_id", "id");
-- One thread per resident and representative.
CREATE UNIQUE INDEX "representative_threads_once"
  ON "representative_threads"("tenant_id", "representative_id", "writer_account_id");
CREATE INDEX "representative_threads_representative_idx"
  ON "representative_threads"("tenant_id", "representative_id", "last_message_at", "id");
ALTER TABLE "representative_threads"
  ADD CONSTRAINT "representative_threads_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "representative_threads_tenant_id_representative_fkey"
  FOREIGN KEY ("tenant_id", "representative_id") REFERENCES "governance_representatives"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "representative_threads_tenant_id_writer_fkey"
  FOREIGN KEY ("tenant_id", "writer_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "representative_threads_tenant_id_unit_id_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "representative_threads" ADD CONSTRAINT "representative_threads_times"
  CHECK ("last_message_at" >= "created_at");

-- Only its last message's time moves, forward.
CREATE FUNCTION representative_thread_moves() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."representative_id" = OLD."representative_id"
     AND NEW."writer_account_id" = OLD."writer_account_id"
     AND NEW."unit_id" = OLD."unit_id"
     AND NEW."created_at" = OLD."created_at"
     AND NEW."last_message_at" >= OLD."last_message_at" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'representative_threads: only the last message time moves (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER representative_threads_moves
  BEFORE UPDATE OR DELETE ON "representative_threads"
  FOR EACH ROW EXECUTE FUNCTION representative_thread_moves();
CREATE TRIGGER representative_threads_moves_truncate
  BEFORE TRUNCATE ON "representative_threads"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

CREATE TABLE "representative_messages" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "thread_id" UUID NOT NULL,
    "side" TEXT NOT NULL,
    "author_account_id" UUID NOT NULL,
    "body" TEXT,
    "body_cleared_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "representative_messages_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "representative_messages_tenant_id_id_key"
  ON "representative_messages"("tenant_id", "id");
CREATE INDEX "representative_messages_thread_idx"
  ON "representative_messages"("tenant_id", "thread_id", "created_at", "id");
CREATE INDEX "representative_messages_author_idx"
  ON "representative_messages"("tenant_id", "author_account_id")
  WHERE "body_cleared_at" IS NULL;
ALTER TABLE "representative_messages"
  ADD CONSTRAINT "representative_messages_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "representative_messages_tenant_id_thread_fkey"
  FOREIGN KEY ("tenant_id", "thread_id") REFERENCES "representative_threads"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "representative_messages_tenant_id_author_fkey"
  FOREIGN KEY ("tenant_id", "author_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "representative_messages" ADD CONSTRAINT "representative_messages_side"
  CHECK ("side" IN ('resident', 'representative'));
ALTER TABLE "representative_messages" ADD CONSTRAINT "representative_messages_body"
  CHECK (("body" IS NULL) = ("body_cleared_at" IS NOT NULL)
     AND ("body" IS NULL OR char_length("body") BETWEEN 1 AND 2000));

-- Written once; the words cleared once, by their author's erasure.
CREATE FUNCTION representative_message_cleared_once() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."thread_id" = OLD."thread_id" AND NEW."side" = OLD."side"
     AND NEW."author_account_id" = OLD."author_account_id"
     AND NEW."created_at" = OLD."created_at"
     AND OLD."body_cleared_at" IS NULL AND NEW."body" IS NULL
     AND NEW."body_cleared_at" IS NOT NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'representative_messages: written once, cleared once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER representative_messages_cleared_once
  BEFORE UPDATE OR DELETE ON "representative_messages"
  FOR EACH ROW EXECUTE FUNCTION representative_message_cleared_once();
CREATE TRIGGER representative_messages_cleared_once_truncate
  BEFORE TRUNCATE ON "representative_messages"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- A board matter about a building's representative: name an owner
-- (`appoint`; a new one replaces the sitting one) or end a term (`end`). A
-- sitting member raises it, one pending per building; the board decides it
-- by a carried motion (approve or reject), and an approval applies it in
-- the deciding transaction, or records why it could not: the owner no
-- longer owns a unit there, already sits, or the term already ended. Its
-- raiser withdraws it while pending. The matter never changes otherwise.
-- ----------------------------------------------------------------------------
CREATE TABLE "governance_representative_matters" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "building" TEXT NOT NULL,
    "account_id" UUID NOT NULL,
    "representative_id" UUID,
    "raised_by_account_id" UUID NOT NULL,
    "raised_at" TIMESTAMPTZ(3) NOT NULL,
    "deadline_at" TIMESTAMPTZ(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "decided_at" TIMESTAMPTZ(3),
    "decided_motion_id" UUID,
    "effect" TEXT,
    "effect_reason" TEXT,
    "withdrawn_at" TIMESTAMPTZ(3),
    "withdrawn_by_account_id" UUID,
    CONSTRAINT "governance_representative_matters_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "governance_representative_matters_tenant_id_id_key"
  ON "governance_representative_matters"("tenant_id", "id");
-- One pending matter per building: what it decides is never raced by another.
CREATE UNIQUE INDEX "governance_representative_matters_one_pending"
  ON "governance_representative_matters"("tenant_id", "building")
  WHERE "status" = 'pending';
CREATE INDEX "governance_representative_matters_status_idx"
  ON "governance_representative_matters"("tenant_id", "status", "raised_at", "id");
ALTER TABLE "governance_representative_matters"
  ADD CONSTRAINT "governance_representative_matters_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "governance_representative_matters_tenant_id_account_fkey"
  FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "governance_representative_matters_tenant_id_representative_fkey"
  FOREIGN KEY ("tenant_id", "representative_id") REFERENCES "governance_representatives"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "governance_representative_matters_tenant_id_raised_by_fkey"
  FOREIGN KEY ("tenant_id", "raised_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "governance_representative_matters_tenant_id_motion_id_fkey"
  FOREIGN KEY ("tenant_id", "decided_motion_id") REFERENCES "board_motions"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "governance_representative_matters_tenant_id_withdrawn_by_fkey"
  FOREIGN KEY ("tenant_id", "withdrawn_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE UNIQUE INDEX "governance_representative_matters_motion_key"
  ON "governance_representative_matters"("tenant_id", "decided_motion_id")
  WHERE "decided_motion_id" IS NOT NULL;
-- An appointment names the owner; an end names the term (and its holder).
ALTER TABLE "governance_representative_matters" ADD CONSTRAINT "governance_representative_matters_action"
  CHECK (("action" = 'appoint' AND "representative_id" IS NULL)
      OR ("action" = 'end' AND "representative_id" IS NOT NULL));
ALTER TABLE "governance_representative_matters" ADD CONSTRAINT "governance_representative_matters_building"
  CHECK (char_length("building") BETWEEN 1 AND 100);
-- Pending, or moved once: decided by a motion (an approval with its
-- effect), or withdrawn by its raiser. REPRESENTATIVE_MATTER_EFFECT_REASONS.
ALTER TABLE "governance_representative_matters" ADD CONSTRAINT "governance_representative_matters_state_shape"
  CHECK ("deadline_at" > "raised_at"
     AND CASE "status"
           WHEN 'pending' THEN "decided_at" IS NULL AND "decided_motion_id" IS NULL
                AND "effect" IS NULL AND "withdrawn_at" IS NULL AND "withdrawn_by_account_id" IS NULL
           WHEN 'approved' THEN "decided_at" IS NOT NULL AND "decided_motion_id" IS NOT NULL
                AND "effect" IS NOT NULL AND "withdrawn_at" IS NULL AND "withdrawn_by_account_id" IS NULL
           WHEN 'rejected' THEN "decided_at" IS NOT NULL AND "decided_motion_id" IS NOT NULL
                AND "effect" IS NULL AND "withdrawn_at" IS NULL AND "withdrawn_by_account_id" IS NULL
           WHEN 'withdrawn' THEN "decided_at" IS NULL AND "decided_motion_id" IS NULL
                AND "effect" IS NULL AND "withdrawn_at" IS NOT NULL AND "withdrawn_by_account_id" IS NOT NULL
           ELSE FALSE END
     AND ("decided_at" IS NULL OR "decided_at" >= "raised_at")
     AND ("withdrawn_at" IS NULL OR "withdrawn_at" >= "raised_at"));
ALTER TABLE "governance_representative_matters" ADD CONSTRAINT "governance_representative_matters_effect"
  CHECK (CASE WHEN "effect" IS NULL THEN "effect_reason" IS NULL
              WHEN "effect" = 'applied' THEN "effect_reason" IS NULL
              WHEN "effect" = 'not_applied' THEN "effect_reason" IS NOT NULL
                   AND "effect_reason" IN ('not_an_owner', 'already_sitting', 'already_ended')
                   AND ("action" = 'end') = ("effect_reason" = 'already_ended')
              ELSE FALSE END);

CREATE FUNCTION governance_representative_matter_moves() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."action" = OLD."action" AND NEW."building" = OLD."building"
     AND NEW."account_id" = OLD."account_id"
     AND NEW."representative_id" IS NOT DISTINCT FROM OLD."representative_id"
     AND NEW."raised_by_account_id" = OLD."raised_by_account_id"
     AND NEW."raised_at" = OLD."raised_at"
     AND NEW."deadline_at" = OLD."deadline_at"
     AND OLD."status" = 'pending' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'governance_representative_matters: the matter is kept and moves from pending once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER governance_representative_matters_moves
  BEFORE UPDATE OR DELETE ON "governance_representative_matters"
  FOR EACH ROW EXECUTE FUNCTION governance_representative_matter_moves();
CREATE TRIGGER governance_representative_matters_moves_truncate
  BEFORE TRUNCATE ON "governance_representative_matters"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- A term is named by an approved matter, and ended by one (or the system).
ALTER TABLE "governance_representatives"
  ADD CONSTRAINT "governance_representatives_tenant_id_appointed_by_fkey"
  FOREIGN KEY ("tenant_id", "appointed_by_matter_id") REFERENCES "governance_representative_matters"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "governance_representatives_tenant_id_ended_by_fkey"
  FOREIGN KEY ("tenant_id", "ended_by_matter_id") REFERENCES "governance_representative_matters"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ----------------------------------------------------------------------------
-- Motions on representative matters (ADR 0055's, as on approvals): approve
-- or reject, no alternatives. Whom the matter is about is recused.
-- ----------------------------------------------------------------------------
ALTER TABLE "board_motions" ADD COLUMN "representative_matter_id" UUID;
ALTER TABLE "board_motions"
  ADD CONSTRAINT "board_motions_tenant_id_representative_matter_id_fkey"
  FOREIGN KEY ("tenant_id", "representative_matter_id") REFERENCES "governance_representative_matters"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE UNIQUE INDEX "board_motions_one_open_per_representative_matter"
  ON "board_motions"("tenant_id", "representative_matter_id")
  WHERE "closed_at" IS NULL AND "representative_matter_id" IS NOT NULL;
CREATE INDEX "board_motions_representative_matter_idx"
  ON "board_motions"("tenant_id", "representative_matter_id", "opened_at", "id");
ALTER TABLE "board_motions" DROP CONSTRAINT "board_motions_one_matter";
ALTER TABLE "board_motions" ADD CONSTRAINT "board_motions_one_matter"
  CHECK (num_nonnulls("approval_request_id", "board_appeal_id", "representative_matter_id") = 1);
ALTER TABLE "board_motions" DROP CONSTRAINT "board_motions_outcome";
ALTER TABLE "board_motions" ADD CONSTRAINT "board_motions_outcome"
  CHECK ("outcome" IN ('approve', 'reject', 'uphold', 'overturn')
     AND ("approval_request_id" IS NULL OR "outcome" IN ('approve', 'reject'))
     AND ("board_appeal_id" IS NULL OR "outcome" IN ('uphold', 'overturn'))
     AND ("representative_matter_id" IS NULL OR "outcome" IN ('approve', 'reject')));

CREATE OR REPLACE FUNCTION board_motion_moves() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."approval_request_id" IS NOT DISTINCT FROM OLD."approval_request_id"
     AND NEW."board_appeal_id" IS NOT DISTINCT FROM OLD."board_appeal_id"
     AND NEW."representative_matter_id" IS NOT DISTINCT FROM OLD."representative_matter_id"
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

-- Recusals: an appeal's motion, and now a representative matter's.
CREATE OR REPLACE FUNCTION board_motion_recusal_fixed() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "board_motions" m
       WHERE m."tenant_id" = NEW."tenant_id" AND m."id" = NEW."motion_id"
         AND (m."board_appeal_id" IS NOT NULL OR m."representative_matter_id" IS NOT NULL)
         AND m."closed_at" IS NULL
    ) OR EXISTS (
      SELECT 1 FROM "board_votes" v
       WHERE v."tenant_id" = NEW."tenant_id" AND v."motion_id" = NEW."motion_id"
    ) THEN
      RAISE EXCEPTION 'board_motion_recusals: written when an appeal''s or a representative matter''s motion opens, before any vote'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'board_motion_recusals: a recusal is never changed (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

-- At commit: a matter is approved or rejected exactly when a carried motion
-- names it with the matching outcome, the one it names.
CREATE FUNCTION governance_representative_matter_decided_by_motion() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  r uuid;
  st text;
  dm uuid;
  carried integer;
  matching integer;
BEGIN
  IF TG_TABLE_NAME = 'governance_representative_matters' THEN
    r := NEW."id";
  ELSE
    r := NEW."representative_matter_id";
    IF r IS NULL THEN
      RETURN NULL;
    END IF;
  END IF;
  SELECT x."status", x."decided_motion_id" INTO st, dm
    FROM "governance_representative_matters" x
   WHERE x."tenant_id" = NEW."tenant_id" AND x."id" = r;
  SELECT count(*) INTO carried
    FROM "board_motions" m
   WHERE m."tenant_id" = NEW."tenant_id" AND m."representative_matter_id" = r
     AND m."result" = 'carried';
  SELECT count(*) INTO matching
    FROM "board_motions" m
   WHERE m."tenant_id" = NEW."tenant_id" AND m."id" = dm
     AND m."representative_matter_id" = r AND m."result" = 'carried'
     AND m."outcome" = CASE st WHEN 'approved' THEN 'approve' WHEN 'rejected' THEN 'reject' END;
  IF (st IN ('approved', 'rejected')) <> (carried = 1 AND matching = 1)
     OR (st NOT IN ('approved', 'rejected') AND carried <> 0) THEN
    RAISE EXCEPTION 'representative matter %: decided (%) exactly by one carried motion with its outcome (% carried, % matching)', r, st, carried, matching
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER governance_representative_matters_decided
  AFTER UPDATE OF "status" ON "governance_representative_matters" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (OLD."status" IS DISTINCT FROM NEW."status")
  EXECUTE FUNCTION governance_representative_matter_decided_by_motion();
CREATE CONSTRAINT TRIGGER board_motions_carried_representative_matter
  AFTER UPDATE OF "result" ON "board_motions" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."result" = 'carried')
  EXECUTE FUNCTION governance_representative_matter_decided_by_motion();

REVOKE ALL ON "governance_representatives", "representative_threads", "representative_messages",
  "governance_representative_matters" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "governance_representatives", "representative_threads", "representative_messages",
  "governance_representative_matters" TO jiwar_app;
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['governance_representatives', 'representative_threads', 'representative_messages',
                           'governance_representative_matters'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
