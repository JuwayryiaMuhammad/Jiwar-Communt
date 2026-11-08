-- ============================================================================
-- The field team, part b (ADR 0090): peak reinforcement.
-- ============================================================================
--
-- The system suggests, the field team decides; nothing reaches a
-- technician off duty by itself.
--
-- * `reinforcement_suggestions`: made when service pressure's rise is told
--   (ADR 0079), with its figures then. One open per compound (a partial
--   unique index behind the pressure row's lock). Answered once by a call,
--   dismissed once with a code, or lapsed when the pressure eases.
-- * `reinforcement_calls`: the field team asks the technicians off duty to
--   come in: how many (1 to 10), a window that starts within 12 hours and
--   lasts 1 to 12, a zone or the whole compound. Filled once as many
--   accepted, closed at its start, or called off once with a code.
-- * `reinforcement_call_recipients`: whom it reached at the send, and each
--   one's answer, once: accepted (with the roster slot it wrote) or
--   declined.

CREATE TABLE "reinforcement_suggestions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "raised_at" TIMESTAMPTZ(3) NOT NULL,
    "open_tickets" INTEGER NOT NULL,
    "available" INTEGER NOT NULL,
    "threshold" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "decided_at" TIMESTAMPTZ(3),
    "decided_by_account_id" UUID,
    "reason_code" TEXT,
    "call_id" UUID,

    CONSTRAINT "reinforcement_suggestions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "reinforcement_suggestions_tenant_id_id_key"
  ON "reinforcement_suggestions" ("tenant_id", "id");
-- One open suggestion per compound.
CREATE UNIQUE INDEX "reinforcement_suggestions_one_open_key"
  ON "reinforcement_suggestions" ("tenant_id")
  WHERE "status" = 'open';
CREATE UNIQUE INDEX "reinforcement_suggestions_call_key"
  ON "reinforcement_suggestions" ("tenant_id", "call_id");
CREATE INDEX "reinforcement_suggestions_created_idx"
  ON "reinforcement_suggestions" ("tenant_id", "created_at" DESC, "id" DESC);

CREATE TABLE "reinforcement_calls" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "sent_by_account_id" UUID NOT NULL,
    "suggestion_id" UUID,
    "needed" SMALLINT NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "place_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'open',
    "recipients" INTEGER NOT NULL,
    "accepted" SMALLINT NOT NULL DEFAULT 0,
    "sent_at" TIMESTAMPTZ(3) NOT NULL,
    "closed_at" TIMESTAMPTZ(3),
    "cancelled_by_account_id" UUID,
    "cancel_reason" TEXT,

    CONSTRAINT "reinforcement_calls_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "reinforcement_calls_tenant_id_id_key"
  ON "reinforcement_calls" ("tenant_id", "id");
CREATE INDEX "reinforcement_calls_sent_idx"
  ON "reinforcement_calls" ("tenant_id", "sent_at" DESC, "id" DESC);
-- The sweep's: open calls by their start.
CREATE INDEX "reinforcement_calls_open_idx"
  ON "reinforcement_calls" ("tenant_id", "starts_at")
  WHERE "status" = 'open';

ALTER TABLE "reinforcement_suggestions"
  ADD CONSTRAINT "reinforcement_suggestions_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "reinforcement_suggestions_decided_by_fkey"
    FOREIGN KEY ("tenant_id", "decided_by_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "reinforcement_suggestions_call_fkey"
    FOREIGN KEY ("tenant_id", "call_id") REFERENCES "reinforcement_calls"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "reinforcement_suggestions_figures"
    CHECK ("open_tickets" >= 0 AND "available" >= 0 AND "threshold" BETWEEN 1 AND 100),
  -- Each status carries exactly its facts; a dismissal names a code of
  -- REASON_CODES.reinforcementDismiss (a unit test keeps them in step).
  ADD CONSTRAINT "reinforcement_suggestions_status_shape"
    CHECK (("status" = 'open'
            AND "decided_at" IS NULL AND "decided_by_account_id" IS NULL
            AND "reason_code" IS NULL AND "call_id" IS NULL)
        OR ("status" = 'answered'
            AND "decided_at" IS NOT NULL AND "decided_by_account_id" IS NOT NULL
            AND "reason_code" IS NULL AND "call_id" IS NOT NULL)
        OR ("status" = 'dismissed'
            AND "decided_at" IS NOT NULL AND "decided_by_account_id" IS NOT NULL
            AND "reason_code" IN ('enough_on_duty', 'pressure_easing', 'nobody_to_call', 'other')
            AND "call_id" IS NULL)
        OR ("status" = 'lapsed'
            AND "decided_at" IS NOT NULL AND "decided_by_account_id" IS NULL
            AND "reason_code" IS NULL AND "call_id" IS NULL));

ALTER TABLE "reinforcement_calls"
  ADD CONSTRAINT "reinforcement_calls_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "reinforcement_calls_sent_by_fkey"
    FOREIGN KEY ("tenant_id", "sent_by_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "reinforcement_calls_suggestion_fkey"
    FOREIGN KEY ("tenant_id", "suggestion_id") REFERENCES "reinforcement_suggestions"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "reinforcement_calls_place_fkey"
    FOREIGN KEY ("tenant_id", "place_id") REFERENCES "places"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "reinforcement_calls_cancelled_by_fkey"
    FOREIGN KEY ("tenant_id", "cancelled_by_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "reinforcement_calls_needed"
    CHECK ("needed" BETWEEN 1 AND 10 AND "accepted" BETWEEN 0 AND "needed" AND "recipients" >= 0),
  -- A window of 1 to 12 hours.
  ADD CONSTRAINT "reinforcement_calls_window"
    CHECK ("ends_at" >= "starts_at" + INTERVAL '1 hour'
       AND "ends_at" <= "starts_at" + INTERVAL '12 hours'
       AND "starts_at" > "sent_at"),
  -- Each status carries exactly its facts; a call-off names a code of
  -- REASON_CODES.reinforcementCancel.
  ADD CONSTRAINT "reinforcement_calls_status_shape"
    CHECK (("status" = 'open'
            AND "closed_at" IS NULL AND "cancelled_by_account_id" IS NULL AND "cancel_reason" IS NULL
            AND "accepted" < "needed")
        OR ("status" = 'filled'
            AND "closed_at" IS NOT NULL AND "cancelled_by_account_id" IS NULL AND "cancel_reason" IS NULL
            AND "accepted" = "needed")
        OR ("status" = 'closed'
            AND "closed_at" IS NOT NULL AND "cancelled_by_account_id" IS NULL AND "cancel_reason" IS NULL)
        OR ("status" = 'cancelled'
            AND "closed_at" IS NOT NULL AND "cancelled_by_account_id" IS NOT NULL
            AND "cancel_reason" IN ('no_longer_needed', 'pressure_eased', 'raised_in_error', 'other')));

-- A suggestion keeps its figures and is decided once.
CREATE FUNCTION reinforcement_suggestion_decided_once() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."raised_at" = OLD."raised_at"
     AND NEW."open_tickets" = OLD."open_tickets"
     AND NEW."available" = OLD."available"
     AND NEW."threshold" = OLD."threshold"
     AND NEW."created_at" = OLD."created_at"
     AND OLD."status" = 'open' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'reinforcement_suggestions: a suggestion is decided once and never deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER reinforcement_suggestions_decided_once
  BEFORE UPDATE OR DELETE ON "reinforcement_suggestions"
  FOR EACH ROW EXECUTE FUNCTION reinforcement_suggestion_decided_once();
CREATE TRIGGER reinforcement_suggestions_decided_once_truncate
  BEFORE TRUNCATE ON "reinforcement_suggestions"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- A call keeps what it asked; while open, only its accepted count grows,
-- and it ends once.
CREATE FUNCTION reinforcement_call_moves_forward() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."sent_by_account_id" = OLD."sent_by_account_id"
     AND NEW."suggestion_id" IS NOT DISTINCT FROM OLD."suggestion_id"
     AND NEW."needed" = OLD."needed"
     AND NEW."starts_at" = OLD."starts_at"
     AND NEW."ends_at" = OLD."ends_at"
     AND NEW."place_id" IS NOT DISTINCT FROM OLD."place_id"
     AND NEW."recipients" = OLD."recipients"
     AND NEW."sent_at" = OLD."sent_at"
     AND NEW."accepted" >= OLD."accepted"
     AND OLD."status" = 'open' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'reinforcement_calls: a call keeps what it asked and ends once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER reinforcement_calls_move_forward
  BEFORE UPDATE OR DELETE ON "reinforcement_calls"
  FOR EACH ROW EXECUTE FUNCTION reinforcement_call_moves_forward();
CREATE TRIGGER reinforcement_calls_move_forward_truncate
  BEFORE TRUNCATE ON "reinforcement_calls"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

CREATE TABLE "reinforcement_call_recipients" (
    "tenant_id" UUID NOT NULL,
    "call_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "answer" TEXT,
    "answered_at" TIMESTAMPTZ(3),
    "slot_id" UUID,

    CONSTRAINT "reinforcement_call_recipients_pkey" PRIMARY KEY ("tenant_id", "call_id", "account_id")
);

CREATE INDEX "reinforcement_call_recipients_account_idx"
  ON "reinforcement_call_recipients" ("tenant_id", "account_id");
CREATE UNIQUE INDEX "reinforcement_call_recipients_slot_key"
  ON "reinforcement_call_recipients" ("tenant_id", "slot_id");

ALTER TABLE "reinforcement_call_recipients"
  ADD CONSTRAINT "reinforcement_call_recipients_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "reinforcement_call_recipients_call_fkey"
    FOREIGN KEY ("tenant_id", "call_id") REFERENCES "reinforcement_calls"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "reinforcement_call_recipients_account_fkey"
    FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "reinforcement_call_recipients_slot_fkey"
    FOREIGN KEY ("tenant_id", "slot_id") REFERENCES "guard_roster_slots"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "reinforcement_call_recipients_answer_shape"
    CHECK (("answer" IS NULL AND "answered_at" IS NULL AND "slot_id" IS NULL)
        OR ("answer" = 'accepted' AND "answered_at" IS NOT NULL AND "slot_id" IS NOT NULL)
        OR ("answer" = 'declined' AND "answered_at" IS NOT NULL AND "slot_id" IS NULL));

-- Whom a call reached stays; each answers once.
CREATE FUNCTION reinforcement_recipient_answers_once() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."call_id" = OLD."call_id"
     AND NEW."account_id" = OLD."account_id"
     AND OLD."answer" IS NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'reinforcement_call_recipients: each answers once, and whom a call reached stays (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER reinforcement_call_recipients_answer_once
  BEFORE UPDATE OR DELETE ON "reinforcement_call_recipients"
  FOR EACH ROW EXECUTE FUNCTION reinforcement_recipient_answers_once();
CREATE TRIGGER reinforcement_call_recipients_answer_once_truncate
  BEFORE TRUNCATE ON "reinforcement_call_recipients"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "reinforcement_suggestions" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "reinforcement_suggestions" TO jiwar_app;
REVOKE ALL ON "reinforcement_calls" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "reinforcement_calls" TO jiwar_app;
REVOKE ALL ON "reinforcement_call_recipients" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "reinforcement_call_recipients" TO jiwar_app;

ALTER TABLE "reinforcement_suggestions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reinforcement_suggestions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "reinforcement_suggestions"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "reinforcement_calls" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reinforcement_calls" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "reinforcement_calls"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "reinforcement_call_recipients" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reinforcement_call_recipients" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "reinforcement_call_recipients"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
