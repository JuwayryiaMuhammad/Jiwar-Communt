-- ============================================================================
-- Board meetings (ADR 0075).
--
-- A sitting member (or the manager) schedules a meeting of the board that
-- sits: regular or extraordinary, its title and place, when, and its
-- agenda — up to 30 items, each a pending approval request, a pending
-- appeal to the board, an owner's open agenda proposal, or an item of its
-- own words. Until it is held the meeting and its agenda may change; it is
-- held once (who of the seats sitting then was present, and whether that
-- made a quorum, ⌊seated/2⌋+1) or cancelled once with a code. Once held,
-- its minutes are a board publication of kind `minutes` (ADR 0051), linked
-- once, and its action items are written: each with an owner (a sitting
-- member or the manager) and a due day, done or cancelled once, its owner
-- told once when it runs past its day.
-- ============================================================================

ALTER TABLE "governance_counters" DROP CONSTRAINT "governance_counters_kind";
ALTER TABLE "governance_counters" ADD CONSTRAINT "governance_counters_kind"
  CHECK ("kind" IN ('poll', 'election', 'approval', 'appeal', 'meeting'));

CREATE TABLE "board_meetings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "term_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "location" TEXT,
    "scheduled_at" TIMESTAMPTZ(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "held_at" TIMESTAMPTZ(3),
    "seated_count" SMALLINT,
    "present_count" SMALLINT,
    "quorate" BOOLEAN,
    "minutes_publication_id" UUID,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" TEXT,
    "author_side" TEXT NOT NULL,
    "created_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "board_meetings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "board_meetings_tenant_id_id_key" ON "board_meetings"("tenant_id", "id");
CREATE UNIQUE INDEX "board_meetings_number_key" ON "board_meetings"("tenant_id", "number");
-- One meeting per minutes publication.
CREATE UNIQUE INDEX "board_meetings_minutes_key" ON "board_meetings"("tenant_id", "minutes_publication_id")
  WHERE "minutes_publication_id" IS NOT NULL;
CREATE INDEX "board_meetings_term_idx" ON "board_meetings"("tenant_id", "term_id", "scheduled_at", "id");
CREATE INDEX "board_meetings_scheduled_idx" ON "board_meetings"("tenant_id", "scheduled_at", "id");
ALTER TABLE "board_meetings"
  ADD CONSTRAINT "board_meetings_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "board_meetings_tenant_id_term_id_fkey"
  FOREIGN KEY ("tenant_id", "term_id") REFERENCES "board_terms"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "board_meetings_tenant_id_minutes_fkey"
  FOREIGN KEY ("tenant_id", "minutes_publication_id") REFERENCES "board_publications"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "board_meetings_tenant_id_created_by_fkey"
  FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- MEETING_KINDS and MEETING_LIMITS; a unit test keeps them in step.
ALTER TABLE "board_meetings" ADD CONSTRAINT "board_meetings_shape"
  CHECK ("number" >= 1
     AND "kind" IN ('regular', 'extraordinary')
     AND char_length("title") BETWEEN 1 AND 200
     AND ("location" IS NULL OR char_length("location") BETWEEN 1 AND 200)
     AND "author_side" IN ('manager', 'board'));
-- MEETING_STATUSES and REASON_CODES.boardMeetingCancel; held with its
-- attendance, cancelled with its code, each once; minutes only once held.
ALTER TABLE "board_meetings" ADD CONSTRAINT "board_meetings_state_shape"
  CHECK ("status" IN ('scheduled', 'held', 'cancelled')
     AND ("status" = 'held') = ("held_at" IS NOT NULL)
     AND ("held_at" IS NULL) = ("seated_count" IS NULL)
     AND ("held_at" IS NULL) = ("present_count" IS NULL)
     AND ("held_at" IS NULL) = ("quorate" IS NULL)
     AND ("present_count" IS NULL OR ("seated_count" IS NOT NULL
                                      AND "present_count" BETWEEN 0 AND "seated_count"))
     AND ("minutes_publication_id" IS NULL OR "held_at" IS NOT NULL)
     AND ("status" = 'cancelled') = ("cancelled_at" IS NOT NULL)
     AND ("cancelled_at" IS NULL) = ("cancel_reason" IS NULL)
     AND ("cancel_reason" IS NULL
          OR "cancel_reason" IN ('postponed', 'no_quorum_expected', 'superseded', 'other')));

-- While scheduled its terms change; it is held or cancelled once; once held
-- only its minutes are linked, once.
CREATE FUNCTION board_meeting_moves() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."term_id" = OLD."term_id" AND NEW."number" = OLD."number"
     AND NEW."author_side" = OLD."author_side"
     AND NEW."created_by_account_id" = OLD."created_by_account_id"
     AND NEW."created_at" = OLD."created_at"
     AND (OLD."status" = 'scheduled'
          OR (NEW."status" = OLD."status"
              AND NEW."kind" = OLD."kind" AND NEW."title" = OLD."title"
              AND NEW."location" IS NOT DISTINCT FROM OLD."location"
              AND NEW."scheduled_at" = OLD."scheduled_at"
              AND NEW."held_at" IS NOT DISTINCT FROM OLD."held_at"
              AND NEW."seated_count" IS NOT DISTINCT FROM OLD."seated_count"
              AND NEW."present_count" IS NOT DISTINCT FROM OLD."present_count"
              AND NEW."quorate" IS NOT DISTINCT FROM OLD."quorate"
              AND NEW."cancelled_at" IS NOT DISTINCT FROM OLD."cancelled_at"
              AND NEW."cancel_reason" IS NOT DISTINCT FROM OLD."cancel_reason"))
     AND (NEW."minutes_publication_id" IS NOT DISTINCT FROM OLD."minutes_publication_id"
          OR OLD."minutes_publication_id" IS NULL) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'board_meetings: changed while scheduled, then held or cancelled once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER board_meetings_moves
  BEFORE UPDATE OR DELETE ON "board_meetings"
  FOR EACH ROW EXECUTE FUNCTION board_meeting_moves();
CREATE TRIGGER board_meetings_moves_truncate
  BEFORE TRUNCATE ON "board_meetings"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- The agenda: rewritten as a whole while the meeting is scheduled.
-- ----------------------------------------------------------------------------
CREATE TABLE "board_meeting_agenda_items" (
    "tenant_id" UUID NOT NULL,
    "meeting_id" UUID NOT NULL,
    "position" SMALLINT NOT NULL,
    "kind" TEXT NOT NULL,
    "approval_request_id" UUID,
    "board_appeal_id" UUID,
    "agenda_proposal_id" UUID,
    "title" TEXT,
    CONSTRAINT "board_meeting_agenda_items_pkey" PRIMARY KEY ("tenant_id", "meeting_id", "position")
);
ALTER TABLE "board_meeting_agenda_items"
  ADD CONSTRAINT "board_meeting_agenda_items_tenant_id_meeting_fkey"
  FOREIGN KEY ("tenant_id", "meeting_id") REFERENCES "board_meetings"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "board_meeting_agenda_items_tenant_id_request_fkey"
  FOREIGN KEY ("tenant_id", "approval_request_id") REFERENCES "governance_approval_requests"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "board_meeting_agenda_items_tenant_id_appeal_fkey"
  FOREIGN KEY ("tenant_id", "board_appeal_id") REFERENCES "governance_board_appeals"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "board_meeting_agenda_items_tenant_id_proposal_fkey"
  FOREIGN KEY ("tenant_id", "agenda_proposal_id") REFERENCES "governance_agenda_proposals"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- AGENDA_ITEM_KINDS; a unit test keeps them in step. Exactly the subject its
-- kind names; words of its own only for `other`.
ALTER TABLE "board_meeting_agenda_items" ADD CONSTRAINT "board_meeting_agenda_items_shape"
  CHECK ("position" BETWEEN 1 AND 30
     AND "kind" IN ('approval_request', 'board_appeal', 'agenda_proposal', 'other')
     AND ("approval_request_id" IS NOT NULL) = ("kind" = 'approval_request')
     AND ("board_appeal_id" IS NOT NULL) = ("kind" = 'board_appeal')
     AND ("agenda_proposal_id" IS NOT NULL) = ("kind" = 'agenda_proposal')
     AND ("title" IS NOT NULL) = ("kind" = 'other')
     AND ("title" IS NULL OR char_length("title") BETWEEN 1 AND 200));

CREATE FUNCTION board_meeting_agenda_while_scheduled() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  r record;
BEGIN
  IF TG_OP = 'INSERT' THEN r := NEW; ELSE r := OLD; END IF;
  -- A meeting not found is the composite key's (or RLS's) to refuse.
  IF EXISTS (SELECT 1 FROM "board_meetings" m
              WHERE m."tenant_id" = r."tenant_id" AND m."id" = r."meeting_id"
                AND m."status" <> 'scheduled') THEN
    RAISE EXCEPTION 'board_meeting_agenda_items: the agenda is fixed once the meeting is held or cancelled (%)', TG_OP
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER board_meeting_agenda_items_while_scheduled
  BEFORE INSERT OR UPDATE OR DELETE ON "board_meeting_agenda_items"
  FOR EACH ROW EXECUTE FUNCTION board_meeting_agenda_while_scheduled();
CREATE TRIGGER board_meeting_agenda_items_immutable_truncate
  BEFORE TRUNCATE ON "board_meeting_agenda_items"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Who was there: a row per seat sitting when it was held, once.
-- ----------------------------------------------------------------------------
CREATE TABLE "board_meeting_attendance" (
    "tenant_id" UUID NOT NULL,
    "meeting_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "present" BOOLEAN NOT NULL,
    CONSTRAINT "board_meeting_attendance_pkey" PRIMARY KEY ("tenant_id", "meeting_id", "member_id")
);
ALTER TABLE "board_meeting_attendance"
  ADD CONSTRAINT "board_meeting_attendance_tenant_id_meeting_fkey"
  FOREIGN KEY ("tenant_id", "meeting_id") REFERENCES "board_meetings"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "board_meeting_attendance_tenant_id_member_fkey"
  FOREIGN KEY ("tenant_id", "member_id") REFERENCES "board_members"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE TRIGGER board_meeting_attendance_immutable_rows
  BEFORE UPDATE OR DELETE ON "board_meeting_attendance"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER board_meeting_attendance_immutable_truncate
  BEFORE TRUNCATE ON "board_meeting_attendance"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Action items: written once the meeting is held; done or cancelled once.
-- ----------------------------------------------------------------------------
CREATE TABLE "board_meeting_actions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "meeting_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "owner_account_id" UUID NOT NULL,
    "due_on" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "done_at" TIMESTAMPTZ(3),
    "done_by_account_id" UUID,
    "done_note" TEXT,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" TEXT,
    "overdue_notified_at" TIMESTAMPTZ(3),
    "created_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "board_meeting_actions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "board_meeting_actions_tenant_id_id_key" ON "board_meeting_actions"("tenant_id", "id");
CREATE INDEX "board_meeting_actions_meeting_idx" ON "board_meeting_actions"("tenant_id", "meeting_id", "created_at", "id");
CREATE INDEX "board_meeting_actions_open_idx" ON "board_meeting_actions"("tenant_id", "status", "due_on", "id");
CREATE INDEX "board_meeting_actions_owner_idx" ON "board_meeting_actions"("tenant_id", "owner_account_id", "status");
ALTER TABLE "board_meeting_actions"
  ADD CONSTRAINT "board_meeting_actions_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "board_meeting_actions_tenant_id_meeting_fkey"
  FOREIGN KEY ("tenant_id", "meeting_id") REFERENCES "board_meetings"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "board_meeting_actions_tenant_id_owner_fkey"
  FOREIGN KEY ("tenant_id", "owner_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "board_meeting_actions_tenant_id_done_by_fkey"
  FOREIGN KEY ("tenant_id", "done_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "board_meeting_actions_tenant_id_created_by_fkey"
  FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- ACTION_STATUSES, MEETING_LIMITS and REASON_CODES.boardActionCancel; a unit
-- test keeps them in step.
ALTER TABLE "board_meeting_actions" ADD CONSTRAINT "board_meeting_actions_shape"
  CHECK (char_length("title") BETWEEN 1 AND 300
     AND "status" IN ('open', 'done', 'cancelled')
     AND ("status" = 'done') = ("done_at" IS NOT NULL)
     AND ("done_at" IS NULL) = ("done_by_account_id" IS NULL)
     AND ("done_note" IS NULL OR ("done_at" IS NOT NULL AND char_length("done_note") BETWEEN 1 AND 1000))
     AND ("status" = 'cancelled') = ("cancelled_at" IS NOT NULL)
     AND ("cancelled_at" IS NULL) = ("cancel_reason" IS NULL)
     AND ("cancel_reason" IS NULL OR "cancel_reason" IN ('not_needed', 'superseded', 'other'))
     AND ("done_at" IS NULL OR "done_at" >= "created_at")
     AND ("cancelled_at" IS NULL OR "cancelled_at" >= "created_at"));

CREATE FUNCTION board_meeting_action_moves() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."meeting_id" = OLD."meeting_id" AND NEW."title" = OLD."title"
     AND NEW."owner_account_id" = OLD."owner_account_id"
     AND NEW."due_on" = OLD."due_on"
     AND NEW."created_by_account_id" = OLD."created_by_account_id"
     AND NEW."created_at" = OLD."created_at"
     AND (NEW."status" = OLD."status" OR OLD."status" = 'open')
     AND ((NEW."done_at" IS NOT DISTINCT FROM OLD."done_at"
           AND NEW."done_by_account_id" IS NOT DISTINCT FROM OLD."done_by_account_id"
           AND NEW."done_note" IS NOT DISTINCT FROM OLD."done_note"
           AND NEW."cancelled_at" IS NOT DISTINCT FROM OLD."cancelled_at"
           AND NEW."cancel_reason" IS NOT DISTINCT FROM OLD."cancel_reason")
          OR OLD."status" = 'open')
     AND (NEW."overdue_notified_at" IS NOT DISTINCT FROM OLD."overdue_notified_at"
          OR OLD."overdue_notified_at" IS NULL) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'board_meeting_actions: kept as written, done or cancelled once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER board_meeting_actions_moves
  BEFORE UPDATE OR DELETE ON "board_meeting_actions"
  FOR EACH ROW EXECUTE FUNCTION board_meeting_action_moves();
CREATE TRIGGER board_meeting_actions_moves_truncate
  BEFORE TRUNCATE ON "board_meeting_actions"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- Action items only of a meeting held. A meeting not found is the composite
-- key's (or RLS's) to refuse.
CREATE FUNCTION board_meeting_action_of_held() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "board_meetings" m
              WHERE m."tenant_id" = NEW."tenant_id" AND m."id" = NEW."meeting_id"
                AND m."status" <> 'held') THEN
    RAISE EXCEPTION 'board_meeting_actions: only a meeting held has action items'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER board_meeting_actions_of_held
  BEFORE INSERT ON "board_meeting_actions"
  FOR EACH ROW EXECUTE FUNCTION board_meeting_action_of_held();

REVOKE ALL ON "board_meetings", "board_meeting_agenda_items", "board_meeting_attendance",
  "board_meeting_actions" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "board_meetings", "board_meeting_actions" TO jiwar_app;
GRANT SELECT, INSERT, DELETE ON "board_meeting_agenda_items" TO jiwar_app;
GRANT SELECT, INSERT ON "board_meeting_attendance" TO jiwar_app;
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['board_meetings', 'board_meeting_agenda_items',
                           'board_meeting_attendance', 'board_meeting_actions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
