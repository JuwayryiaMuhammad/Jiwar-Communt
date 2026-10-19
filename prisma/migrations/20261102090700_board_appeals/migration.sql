-- ============================================================================
-- Board matters (ADR 0055): appeals to the board. An owner or the unit's
-- primary takes a staff decision already taken (a fine's or a violation's
-- upheld appeal, a suspension in force, a rejected invoice dispute) to the
-- board within 15 days: their grounds (cleared on their erasure) and
-- attachments. One appeal per decision, ever. The board decides it by a
-- motion (uphold | overturn), carried; its subject's domain applies an
-- overturn (`effect` applied) or leaves it to the management (`follow_up`,
-- marked followed up once). The appellant may withdraw it while pending.
-- Past its deadline undecided, the overdue notice goes once.
--
-- A motion on an appeal records, when it opens, who is recused from it:
-- every account living in or owning the appeal's unit, and the appellant
-- (board_motion_recusals, fixed).
-- ============================================================================

CREATE TABLE "governance_board_appeals" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "appellant_account_id" UUID NOT NULL,
    "grounds" TEXT,
    "grounds_cleared_at" TIMESTAMPTZ(3),
    "decision_at" TIMESTAMPTZ(3) NOT NULL,
    "lodged_at" TIMESTAMPTZ(3) NOT NULL,
    "deadline_at" TIMESTAMPTZ(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "decided_at" TIMESTAMPTZ(3),
    "decided_motion_id" UUID,
    "withdrawn_at" TIMESTAMPTZ(3),
    "effect" TEXT,
    "followed_up_at" TIMESTAMPTZ(3),
    "followed_up_by_account_id" UUID,
    "overdue_notified_at" TIMESTAMPTZ(3),
    CONSTRAINT "governance_board_appeals_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "governance_board_appeals_tenant_id_id_key"
  ON "governance_board_appeals"("tenant_id", "id");
CREATE UNIQUE INDEX "governance_board_appeals_number_key"
  ON "governance_board_appeals"("tenant_id", "number");
-- One appeal per staff decision, ever.
CREATE UNIQUE INDEX "governance_board_appeals_one_per_decision"
  ON "governance_board_appeals"("tenant_id", "kind", "subject_id");
CREATE INDEX "governance_board_appeals_status_idx"
  ON "governance_board_appeals"("tenant_id", "status", "lodged_at", "id");
CREATE INDEX "governance_board_appeals_unit_idx"
  ON "governance_board_appeals"("tenant_id", "unit_id", "lodged_at", "id");
CREATE INDEX "governance_board_appeals_appellant_idx"
  ON "governance_board_appeals"("tenant_id", "appellant_account_id");
CREATE INDEX "governance_board_appeals_overdue_idx"
  ON "governance_board_appeals"("tenant_id", "deadline_at")
  WHERE "status" = 'pending' AND "overdue_notified_at" IS NULL;
ALTER TABLE "governance_board_appeals"
  ADD CONSTRAINT "governance_board_appeals_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "governance_board_appeals_tenant_id_unit_id_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "governance_board_appeals_tenant_id_appellant_fkey"
  FOREIGN KEY ("tenant_id", "appellant_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "governance_board_appeals_tenant_id_followed_up_by_fkey"
  FOREIGN KEY ("tenant_id", "followed_up_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- BOARD_APPEAL_KINDS; a unit test keeps them in step.
ALTER TABLE "governance_board_appeals" ADD CONSTRAINT "governance_board_appeals_kind"
  CHECK ("kind" IN ('vehicle_fine', 'unit_violation', 'booking_suspension', 'invoice_dispute'));
ALTER TABLE "governance_board_appeals" ADD CONSTRAINT "governance_board_appeals_number_positive"
  CHECK ("number" >= 1);
-- The grounds: words until cleared, once.
ALTER TABLE "governance_board_appeals" ADD CONSTRAINT "governance_board_appeals_grounds"
  CHECK (("grounds" IS NULL) = ("grounds_cleared_at" IS NOT NULL)
     AND ("grounds" IS NULL OR char_length("grounds") BETWEEN 1 AND 2000));
-- The status and the columns that say it, set together.
ALTER TABLE "governance_board_appeals" ADD CONSTRAINT "governance_board_appeals_state_shape"
  CHECK ("status" IN ('pending', 'upheld', 'overturned', 'withdrawn')
     AND ("status" IN ('upheld', 'overturned')) = ("decided_at" IS NOT NULL)
     AND ("decided_at" IS NULL) = ("decided_motion_id" IS NULL)
     AND ("status" = 'withdrawn') = ("withdrawn_at" IS NOT NULL)
     AND ("status" = 'pending') = ("effect" IS NULL)
     AND ("effect" IS NULL OR "effect" IN ('applied', 'follow_up', 'none'))
     AND ("effect" IS DISTINCT FROM 'follow_up' OR "status" = 'overturned')
     AND ("followed_up_at" IS NULL OR "effect" = 'follow_up')
     AND ("followed_up_at" IS NULL) = ("followed_up_by_account_id" IS NULL)
     AND "deadline_at" > "lodged_at"
     AND "lodged_at" >= "decision_at"
     AND ("overdue_notified_at" IS NULL OR "overdue_notified_at" >= "deadline_at"));

-- What was lodged never changes but the grounds' clearing; the status
-- moves from pending once; a follow-up and the overdue notice once each.
CREATE FUNCTION governance_board_appeal_moves() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."number" = OLD."number" AND NEW."kind" = OLD."kind"
     AND NEW."subject_id" = OLD."subject_id" AND NEW."unit_id" = OLD."unit_id"
     AND NEW."appellant_account_id" = OLD."appellant_account_id"
     AND NEW."decision_at" = OLD."decision_at"
     AND NEW."lodged_at" = OLD."lodged_at"
     AND NEW."deadline_at" = OLD."deadline_at"
     AND ((NEW."grounds" IS NOT DISTINCT FROM OLD."grounds"
           AND NEW."grounds_cleared_at" IS NOT DISTINCT FROM OLD."grounds_cleared_at")
          OR (OLD."grounds_cleared_at" IS NULL AND NEW."grounds" IS NULL))
     AND (NEW."status" = OLD."status" OR OLD."status" = 'pending')
     AND (NEW."decided_at" IS NOT DISTINCT FROM OLD."decided_at" OR OLD."decided_at" IS NULL)
     AND (NEW."decided_motion_id" IS NOT DISTINCT FROM OLD."decided_motion_id" OR OLD."decided_motion_id" IS NULL)
     AND (NEW."withdrawn_at" IS NOT DISTINCT FROM OLD."withdrawn_at" OR OLD."withdrawn_at" IS NULL)
     AND (NEW."effect" IS NOT DISTINCT FROM OLD."effect" OR OLD."effect" IS NULL)
     AND (NEW."followed_up_at" IS NOT DISTINCT FROM OLD."followed_up_at" OR OLD."followed_up_at" IS NULL)
     AND (NEW."followed_up_by_account_id" IS NOT DISTINCT FROM OLD."followed_up_by_account_id" OR OLD."followed_up_at" IS NULL)
     AND (NEW."overdue_notified_at" IS NOT DISTINCT FROM OLD."overdue_notified_at" OR OLD."overdue_notified_at" IS NULL) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'governance_board_appeals: an appeal is kept as lodged and moves forward once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER governance_board_appeals_moves
  BEFORE UPDATE OR DELETE ON "governance_board_appeals"
  FOR EACH ROW EXECUTE FUNCTION governance_board_appeal_moves();
CREATE TRIGGER governance_board_appeals_moves_truncate
  BEFORE TRUNCATE ON "governance_board_appeals"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- An appeal's attachments: written with it, never changed (an erasure
-- marks the files deleted, the rows stay).
CREATE TABLE "governance_board_appeal_attachments" (
    "tenant_id" UUID NOT NULL,
    "appeal_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "position" SMALLINT NOT NULL,
    CONSTRAINT "governance_board_appeal_attachments_pkey" PRIMARY KEY ("tenant_id", "appeal_id", "position")
);
CREATE UNIQUE INDEX "governance_board_appeal_attachments_file_key"
  ON "governance_board_appeal_attachments"("tenant_id", "file_id");
ALTER TABLE "governance_board_appeal_attachments"
  ADD CONSTRAINT "governance_board_appeal_attachments_tenant_id_appeal_id_fkey"
  FOREIGN KEY ("tenant_id", "appeal_id") REFERENCES "governance_board_appeals"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "governance_board_appeal_attachments_tenant_id_file_id_fkey"
  FOREIGN KEY ("tenant_id", "file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "governance_board_appeal_attachments" ADD CONSTRAINT "governance_board_appeal_attachments_position"
  CHECK ("position" BETWEEN 1 AND 3);
CREATE TRIGGER governance_board_appeal_attachments_immutable_rows
  BEFORE UPDATE OR DELETE ON "governance_board_appeal_attachments"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER governance_board_appeal_attachments_immutable_truncate
  BEFORE TRUNCATE ON "governance_board_appeal_attachments"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Motions on appeals.
-- ----------------------------------------------------------------------------
ALTER TABLE "board_motions" ADD COLUMN "board_appeal_id" UUID;
ALTER TABLE "board_motions"
  ADD CONSTRAINT "board_motions_tenant_id_appeal_id_fkey"
  FOREIGN KEY ("tenant_id", "board_appeal_id") REFERENCES "governance_board_appeals"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE UNIQUE INDEX "board_motions_one_open_per_appeal"
  ON "board_motions"("tenant_id", "board_appeal_id")
  WHERE "closed_at" IS NULL AND "board_appeal_id" IS NOT NULL;
CREATE INDEX "board_motions_appeal_idx"
  ON "board_motions"("tenant_id", "board_appeal_id", "opened_at", "id");
ALTER TABLE "board_motions" DROP CONSTRAINT "board_motions_one_matter";
ALTER TABLE "board_motions" ADD CONSTRAINT "board_motions_one_matter"
  CHECK (num_nonnulls("approval_request_id", "board_appeal_id") = 1);
ALTER TABLE "board_motions" DROP CONSTRAINT "board_motions_outcome";
ALTER TABLE "board_motions" ADD CONSTRAINT "board_motions_outcome"
  CHECK ("outcome" IN ('approve', 'reject', 'uphold', 'overturn')
     AND ("approval_request_id" IS NULL OR "outcome" IN ('approve', 'reject'))
     AND ("board_appeal_id" IS NULL OR "outcome" IN ('uphold', 'overturn')));

CREATE OR REPLACE FUNCTION board_motion_moves() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."approval_request_id" IS NOT DISTINCT FROM OLD."approval_request_id"
     AND NEW."board_appeal_id" IS NOT DISTINCT FROM OLD."board_appeal_id"
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

-- Who is recused from a motion on an appeal: written when it opens, before
-- any vote; never changed.
CREATE TABLE "board_motion_recusals" (
    "tenant_id" UUID NOT NULL,
    "motion_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    CONSTRAINT "board_motion_recusals_pkey" PRIMARY KEY ("tenant_id", "motion_id", "account_id")
);
ALTER TABLE "board_motion_recusals"
  ADD CONSTRAINT "board_motion_recusals_tenant_id_motion_id_fkey"
  FOREIGN KEY ("tenant_id", "motion_id") REFERENCES "board_motions"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "board_motion_recusals_tenant_id_account_id_fkey"
  FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION board_motion_recusal_fixed() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "board_motions" m
       WHERE m."tenant_id" = NEW."tenant_id" AND m."id" = NEW."motion_id"
         AND m."board_appeal_id" IS NOT NULL AND m."closed_at" IS NULL
    ) OR EXISTS (
      SELECT 1 FROM "board_votes" v
       WHERE v."tenant_id" = NEW."tenant_id" AND v."motion_id" = NEW."motion_id"
    ) THEN
      RAISE EXCEPTION 'board_motion_recusals: written when an appeal''s motion opens, before any vote'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'board_motion_recusals: a recusal is never changed (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER board_motion_recusals_fixed
  BEFORE INSERT OR UPDATE OR DELETE ON "board_motion_recusals"
  FOR EACH ROW EXECUTE FUNCTION board_motion_recusal_fixed();
CREATE TRIGGER board_motion_recusals_immutable_truncate
  BEFORE TRUNCATE ON "board_motion_recusals"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- At commit: an appeal is upheld or overturned exactly when a carried
-- motion names it with the matching outcome, the one it names.
-- ----------------------------------------------------------------------------
ALTER TABLE "governance_board_appeals"
  ADD CONSTRAINT "governance_board_appeals_tenant_id_motion_id_fkey"
  FOREIGN KEY ("tenant_id", "decided_motion_id") REFERENCES "board_motions"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE UNIQUE INDEX "governance_board_appeals_motion_key"
  ON "governance_board_appeals"("tenant_id", "decided_motion_id")
  WHERE "decided_motion_id" IS NOT NULL;

CREATE FUNCTION governance_board_appeal_decided_by_motion() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  a uuid;
  st text;
  dm uuid;
  carried integer;
  matching integer;
BEGIN
  IF TG_TABLE_NAME = 'governance_board_appeals' THEN
    a := NEW."id";
  ELSE
    a := NEW."board_appeal_id";
    IF a IS NULL THEN
      RETURN NULL;
    END IF;
  END IF;
  SELECT x."status", x."decided_motion_id" INTO st, dm
    FROM "governance_board_appeals" x
   WHERE x."tenant_id" = NEW."tenant_id" AND x."id" = a;
  SELECT count(*) INTO carried
    FROM "board_motions" m
   WHERE m."tenant_id" = NEW."tenant_id" AND m."board_appeal_id" = a
     AND m."result" = 'carried';
  SELECT count(*) INTO matching
    FROM "board_motions" m
   WHERE m."tenant_id" = NEW."tenant_id" AND m."id" = dm
     AND m."board_appeal_id" = a AND m."result" = 'carried'
     AND m."outcome" = CASE st WHEN 'upheld' THEN 'uphold' WHEN 'overturned' THEN 'overturn' END;
  IF (st IN ('upheld', 'overturned')) <> (carried = 1 AND matching = 1)
     OR (st NOT IN ('upheld', 'overturned') AND carried <> 0) THEN
    RAISE EXCEPTION 'board appeal %: decided (%) exactly by one carried motion with its outcome (% carried, % matching)', a, st, carried, matching
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER governance_board_appeals_decided
  AFTER UPDATE OF "status" ON "governance_board_appeals" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (OLD."status" IS DISTINCT FROM NEW."status")
  EXECUTE FUNCTION governance_board_appeal_decided_by_motion();
CREATE CONSTRAINT TRIGGER board_motions_carried_appeal
  AFTER UPDATE OF "result" ON "board_motions" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."result" = 'carried')
  EXECUTE FUNCTION governance_board_appeal_decided_by_motion();

REVOKE ALL ON "governance_board_appeals", "governance_board_appeal_attachments",
  "board_motion_recusals" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "governance_board_appeals" TO jiwar_app;
GRANT SELECT, INSERT ON "governance_board_appeal_attachments", "board_motion_recusals" TO jiwar_app;
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['governance_board_appeals', 'governance_board_appeal_attachments',
                           'board_motion_recusals'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
