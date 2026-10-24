-- ============================================================================
-- The owners' voice in governance (ADR 0059).
--
-- Agenda proposals: an owner proposes a matter for the board (a title and
-- its words), at most three open at once (the service counts them under
-- the owner's lock); a sitting member accepts or declines it once, with a
-- reason code when declined and a note, under the board lock. Accepting
-- binds nothing. The proposer may withdraw it while open; their erasure
-- clears its words, once.
--
-- Objections: an owner objects, once per unit they own, to a decision the
-- board published, within the compound's objection days of it
-- (governance_approval_settings' new `objection` row, 14 by default); the
-- board answers the objections once, with its reasons, sent to every
-- objector. An erasure clears the objector's grounds, once.
--
-- The follow-up of an approved request: progress rows (in progress,
-- implemented, cannot be implemented), append-only, the last two final,
-- once; the implemented mark is the final row. A decision the board
-- published by itself names its request, so the owners reading it see how
-- it is followed up.
-- ============================================================================

ALTER TABLE "governance_approval_settings" DROP CONSTRAINT "governance_approval_settings_type";
ALTER TABLE "governance_approval_settings" ADD CONSTRAINT "governance_approval_settings_type"
  CHECK ("type" IN ('annual_budget', 'budget_increase', 'major_contract', 'exceptional_fee',
                    'waiver_above_limit', 'payment_plan_above_limit', 'legal_escalation', 'board_appeal',
                    'objection'));
-- FORCE RLS applies to the migrator too: one compound at a time.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', t."id"::text, true);
    INSERT INTO "governance_approval_settings" ("tenant_id", "type", "deadline_days")
      VALUES (t."id", 'objection', 14)
      ON CONFLICT DO NOTHING;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;

-- ----------------------------------------------------------------------------
-- Agenda proposals.
-- ----------------------------------------------------------------------------
CREATE TABLE "governance_agenda_proposals" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "author_account_id" UUID NOT NULL,
    "title" TEXT,
    "body" TEXT,
    "text_cleared_at" TIMESTAMPTZ(3),
    "status" TEXT NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "decided_at" TIMESTAMPTZ(3),
    "decided_by_account_id" UUID,
    "decline_reason" TEXT,
    "decision_note" TEXT,
    "withdrawn_at" TIMESTAMPTZ(3),
    CONSTRAINT "governance_agenda_proposals_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "governance_agenda_proposals_tenant_id_id_key"
  ON "governance_agenda_proposals"("tenant_id", "id");
CREATE INDEX "governance_agenda_proposals_status_idx"
  ON "governance_agenda_proposals"("tenant_id", "status", "created_at", "id");
CREATE INDEX "governance_agenda_proposals_author_idx"
  ON "governance_agenda_proposals"("tenant_id", "author_account_id", "status");
ALTER TABLE "governance_agenda_proposals"
  ADD CONSTRAINT "governance_agenda_proposals_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "governance_agenda_proposals_tenant_id_author_fkey"
  FOREIGN KEY ("tenant_id", "author_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "governance_agenda_proposals_tenant_id_decided_by_fkey"
  FOREIGN KEY ("tenant_id", "decided_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- The words: there until cleared, together, once.
ALTER TABLE "governance_agenda_proposals" ADD CONSTRAINT "governance_agenda_proposals_text"
  CHECK (("title" IS NULL) = ("text_cleared_at" IS NOT NULL)
     AND ("body" IS NULL) = ("text_cleared_at" IS NOT NULL)
     AND ("title" IS NULL OR char_length("title") BETWEEN 1 AND 200)
     AND ("body" IS NULL OR char_length("body") BETWEEN 1 AND 4000));
-- AGENDA_STATUSES and REASON_CODES.agendaDecline; a unit test keeps them
-- in step.
ALTER TABLE "governance_agenda_proposals" ADD CONSTRAINT "governance_agenda_proposals_state_shape"
  CHECK ("status" IN ('open', 'accepted', 'declined', 'withdrawn')
     AND ("status" IN ('accepted', 'declined')) = ("decided_at" IS NOT NULL)
     AND ("decided_at" IS NULL) = ("decided_by_account_id" IS NULL)
     AND ("status" = 'declined') = ("decline_reason" IS NOT NULL)
     AND ("decline_reason" IS NULL OR "decline_reason" IN ('out_of_scope', 'duplicate', 'not_now', 'other'))
     AND ("decision_note" IS NULL OR ("decided_at" IS NOT NULL AND char_length("decision_note") BETWEEN 1 AND 1000))
     AND ("status" = 'withdrawn') = ("withdrawn_at" IS NOT NULL)
     AND ("decided_at" IS NULL OR "decided_at" >= "created_at")
     AND ("withdrawn_at" IS NULL OR "withdrawn_at" >= "created_at"));

CREATE FUNCTION governance_agenda_proposal_moves() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."author_account_id" = OLD."author_account_id"
     AND NEW."created_at" = OLD."created_at"
     AND ((NEW."title" IS NOT DISTINCT FROM OLD."title"
           AND NEW."body" IS NOT DISTINCT FROM OLD."body"
           AND NEW."text_cleared_at" IS NOT DISTINCT FROM OLD."text_cleared_at")
          OR (OLD."text_cleared_at" IS NULL AND NEW."title" IS NULL AND NEW."body" IS NULL))
     AND (NEW."status" = OLD."status" OR OLD."status" = 'open')
     AND ((NEW."decided_at" IS NOT DISTINCT FROM OLD."decided_at"
           AND NEW."decided_by_account_id" IS NOT DISTINCT FROM OLD."decided_by_account_id"
           AND NEW."decline_reason" IS NOT DISTINCT FROM OLD."decline_reason"
           AND NEW."decision_note" IS NOT DISTINCT FROM OLD."decision_note"
           AND NEW."withdrawn_at" IS NOT DISTINCT FROM OLD."withdrawn_at")
          OR OLD."status" = 'open') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'governance_agenda_proposals: kept as proposed, decided or withdrawn once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER governance_agenda_proposals_moves
  BEFORE UPDATE OR DELETE ON "governance_agenda_proposals"
  FOR EACH ROW EXECUTE FUNCTION governance_agenda_proposal_moves();
CREATE TRIGGER governance_agenda_proposals_moves_truncate
  BEFORE TRUNCATE ON "governance_agenda_proposals"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Objections to a published decision, and the board's one answer.
-- ----------------------------------------------------------------------------
CREATE TABLE "governance_objections" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "publication_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "author_account_id" UUID NOT NULL,
    "grounds" TEXT,
    "grounds_cleared_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "governance_objections_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "governance_objections_tenant_id_id_key"
  ON "governance_objections"("tenant_id", "id");
-- Once per unit and decision.
CREATE UNIQUE INDEX "governance_objections_once_per_unit"
  ON "governance_objections"("tenant_id", "publication_id", "unit_id");
CREATE INDEX "governance_objections_author_idx"
  ON "governance_objections"("tenant_id", "author_account_id");
ALTER TABLE "governance_objections"
  ADD CONSTRAINT "governance_objections_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "governance_objections_tenant_id_publication_fkey"
  FOREIGN KEY ("tenant_id", "publication_id") REFERENCES "board_publications"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "governance_objections_tenant_id_unit_id_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "governance_objections_tenant_id_author_fkey"
  FOREIGN KEY ("tenant_id", "author_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "governance_objections" ADD CONSTRAINT "governance_objections_grounds"
  CHECK (("grounds" IS NULL) = ("grounds_cleared_at" IS NOT NULL)
     AND ("grounds" IS NULL OR char_length("grounds") BETWEEN 1 AND 2000));

CREATE FUNCTION governance_objection_cleared_once() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."publication_id" = OLD."publication_id" AND NEW."unit_id" = OLD."unit_id"
     AND NEW."author_account_id" = OLD."author_account_id"
     AND NEW."created_at" = OLD."created_at"
     AND OLD."grounds_cleared_at" IS NULL AND NEW."grounds" IS NULL
     AND NEW."grounds_cleared_at" IS NOT NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'governance_objections: kept as lodged, the grounds cleared once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER governance_objections_cleared_once
  BEFORE UPDATE OR DELETE ON "governance_objections"
  FOR EACH ROW EXECUTE FUNCTION governance_objection_cleared_once();
CREATE TRIGGER governance_objections_cleared_once_truncate
  BEFORE TRUNCATE ON "governance_objections"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

CREATE TABLE "governance_objection_replies" (
    "tenant_id" UUID NOT NULL,
    "publication_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "replied_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "governance_objection_replies_pkey" PRIMARY KEY ("tenant_id", "publication_id")
);
ALTER TABLE "governance_objection_replies"
  ADD CONSTRAINT "governance_objection_replies_tenant_id_publication_fkey"
  FOREIGN KEY ("tenant_id", "publication_id") REFERENCES "board_publications"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "governance_objection_replies_tenant_id_replied_by_fkey"
  FOREIGN KEY ("tenant_id", "replied_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "governance_objection_replies" ADD CONSTRAINT "governance_objection_replies_body"
  CHECK (char_length("body") BETWEEN 1 AND 4000);
CREATE TRIGGER governance_objection_replies_immutable_rows
  BEFORE UPDATE OR DELETE ON "governance_objection_replies"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER governance_objection_replies_immutable_truncate
  BEFORE TRUNCATE ON "governance_objection_replies"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- The follow-up of an approved request.
-- ----------------------------------------------------------------------------
CREATE TABLE "governance_approval_progress" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "note" TEXT,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL,
    "recorded_by_account_id" UUID,
    CONSTRAINT "governance_approval_progress_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "governance_approval_progress_tenant_id_id_key"
  ON "governance_approval_progress"("tenant_id", "id");
-- One final row per request.
CREATE UNIQUE INDEX "governance_approval_progress_one_final"
  ON "governance_approval_progress"("tenant_id", "request_id")
  WHERE "status" IN ('implemented', 'cannot_implement');
CREATE INDEX "governance_approval_progress_request_idx"
  ON "governance_approval_progress"("tenant_id", "request_id", "recorded_at", "id");
ALTER TABLE "governance_approval_progress"
  ADD CONSTRAINT "governance_approval_progress_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "governance_approval_progress_tenant_id_request_fkey"
  FOREIGN KEY ("tenant_id", "request_id") REFERENCES "governance_approval_requests"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "governance_approval_progress_tenant_id_recorded_by_fkey"
  FOREIGN KEY ("tenant_id", "recorded_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- APPROVAL_PROGRESS_STATUSES; a unit test keeps them in step.
ALTER TABLE "governance_approval_progress" ADD CONSTRAINT "governance_approval_progress_status"
  CHECK ("status" IN ('in_progress', 'implemented', 'cannot_implement'));
ALTER TABLE "governance_approval_progress" ADD CONSTRAINT "governance_approval_progress_note"
  CHECK ("note" IS NULL OR char_length("note") BETWEEN 1 AND 1000);
CREATE TRIGGER governance_approval_progress_immutable_rows
  BEFORE UPDATE OR DELETE ON "governance_approval_progress"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER governance_approval_progress_immutable_truncate
  BEFORE TRUNCATE ON "governance_approval_progress"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- A decision the board published by itself names its request.
ALTER TABLE "board_publications" ADD COLUMN "approval_request_id" UUID;
ALTER TABLE "board_publications"
  ADD CONSTRAINT "board_publications_tenant_id_request_fkey"
  FOREIGN KEY ("tenant_id", "approval_request_id") REFERENCES "governance_approval_requests"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE UNIQUE INDEX "board_publications_request_key"
  ON "board_publications"("tenant_id", "approval_request_id")
  WHERE "approval_request_id" IS NOT NULL;
ALTER TABLE "board_publications" ADD CONSTRAINT "board_publications_request_kind"
  CHECK ("approval_request_id" IS NULL OR "kind" = 'decision');
CREATE OR REPLACE FUNCTION board_publication_moves() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."kind" = OLD."kind" AND NEW."term_id" = OLD."term_id"
     AND NEW."announcement_id" = OLD."announcement_id"
     AND NEW."decided_on" = OLD."decided_on"
     AND NEW."author_side" = OLD."author_side"
     AND NEW."published_by_account_id" = OLD."published_by_account_id"
     AND NEW."created_at" = OLD."created_at"
     AND NEW."approval_request_id" IS NOT DISTINCT FROM OLD."approval_request_id"
     AND (NEW."archived_at" IS NOT DISTINCT FROM OLD."archived_at"
          OR OLD."archived_at" IS NULL) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'board_publications: a publication is only archived, once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

REVOKE ALL ON "governance_agenda_proposals", "governance_objections", "governance_objection_replies",
  "governance_approval_progress" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "governance_agenda_proposals", "governance_objections" TO jiwar_app;
GRANT SELECT, INSERT ON "governance_objection_replies", "governance_approval_progress" TO jiwar_app;
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['governance_agenda_proposals', 'governance_objections',
                           'governance_objection_replies', 'governance_approval_progress'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
