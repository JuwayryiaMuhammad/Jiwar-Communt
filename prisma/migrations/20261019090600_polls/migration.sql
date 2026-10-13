-- ============================================================================
-- Consultative polls (ADR 0040): one vote per unit, a secret ballot.
--
-- What is stored, and what is not:
--
-- * While a poll is open, its ballots are in ONE row, `poll_ballot_boxes`:
--   a JSON object from a ballot reference to the options chosen. The
--   reference is HMAC-SHA256(ENGAGEMENT_REF_SECRET, salt ‖ poll ‖ unit); the
--   secret is not in the database. One key per unit is what makes a unit's
--   vote unique; changing a vote replaces the value under the same key.
-- * Nothing in the database says which unit a ballot is: no unit column, no
--   account, no time, and — because every ballot lives in the same row,
--   rewritten whole on each vote — no per-ballot row whose system columns
--   (xmin, ctid) could be matched to the audit entry written with it.
-- * When the poll closes, the counts are written to `poll_options`, the box
--   is deleted and the salt is cleared: nothing individual is left, and the
--   references can never be derived again. Only then is "this unit voted"
--   written, to `poll_participations`, for all units at once.
--
-- Personal data here: none of an account's. `poll_participations` says a
-- unit took part, never what it chose.
-- ============================================================================

CREATE TABLE "polls" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "question_en" TEXT,
    "question_ar" TEXT,
    "multiple" BOOLEAN NOT NULL DEFAULT false,
    "opens_at" TIMESTAMPTZ(3) NOT NULL,
    "closes_at" TIMESTAMPTZ(3) NOT NULL,
    "audience_buildings" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "audience_occupancy" "audience_occupancy" NOT NULL DEFAULT 'everyone',
    "ballot_salt" BYTEA,
    "closed_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "final_turnout" INTEGER,
    "created_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "polls_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "polls_tenant_id_id_key" ON "polls"("tenant_id", "id");
CREATE INDEX "polls_closes_idx" ON "polls"("tenant_id", "closes_at", "id");
ALTER TABLE "polls"
  ADD CONSTRAINT "polls_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "polls_tenant_id_created_by_fkey"
  FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "polls" ADD CONSTRAINT "polls_question"
  CHECK (("question_en" IS NOT NULL OR "question_ar" IS NOT NULL)
     AND ("question_en" IS NULL OR char_length("question_en") BETWEEN 1 AND 500)
     AND ("question_ar" IS NULL OR char_length("question_ar") BETWEEN 1 AND 500));
ALTER TABLE "polls" ADD CONSTRAINT "polls_window" CHECK ("closes_at" > "opens_at");
ALTER TABLE "polls" ADD CONSTRAINT "polls_audience_buildings"
  CHECK (cardinality("audience_buildings") <= 50 AND array_position("audience_buildings", NULL) IS NULL);
-- Closed or cancelled, never both; and the salt lives exactly as long as
-- the poll is neither. The turnout is a closed poll's.
ALTER TABLE "polls" ADD CONSTRAINT "polls_end_shape"
  CHECK (("closed_at" IS NULL OR "cancelled_at" IS NULL)
     AND ("ballot_salt" IS NULL) = ("closed_at" IS NOT NULL OR "cancelled_at" IS NOT NULL)
     AND ("final_turnout" IS NULL) = ("closed_at" IS NULL)
     AND ("final_turnout" IS NULL OR "final_turnout" >= 0));
ALTER TABLE "polls" ADD CONSTRAINT "polls_salt_length"
  CHECK ("ballot_salt" IS NULL OR octet_length("ballot_salt") = 32);

-- An option of a poll, in the order the staff gave. `final_count` is
-- written once, when the poll closes.
CREATE TABLE "poll_options" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "poll_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "label_en" TEXT,
    "label_ar" TEXT,
    "final_count" INTEGER,
    CONSTRAINT "poll_options_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "poll_options_position_key" ON "poll_options"("tenant_id", "poll_id", "position");
ALTER TABLE "poll_options"
  ADD CONSTRAINT "poll_options_tenant_id_poll_id_fkey"
  FOREIGN KEY ("tenant_id", "poll_id") REFERENCES "polls"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "poll_options" ADD CONSTRAINT "poll_options_label"
  CHECK (("label_en" IS NOT NULL OR "label_ar" IS NOT NULL)
     AND ("label_en" IS NULL OR char_length("label_en") BETWEEN 1 AND 200)
     AND ("label_ar" IS NULL OR char_length("label_ar") BETWEEN 1 AND 200));
ALTER TABLE "poll_options" ADD CONSTRAINT "poll_options_position"
  CHECK ("position" BETWEEN 1 AND 10);
ALTER TABLE "poll_options" ADD CONSTRAINT "poll_options_final_count"
  CHECK ("final_count" IS NULL OR "final_count" >= 0);

-- The ballot box: one row per open poll. See the header.
CREATE TABLE "poll_ballot_boxes" (
    "tenant_id" UUID NOT NULL,
    "poll_id" UUID NOT NULL,
    "ballots" JSONB NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT "poll_ballot_boxes_pkey" PRIMARY KEY ("tenant_id", "poll_id")
);
ALTER TABLE "poll_ballot_boxes"
  ADD CONSTRAINT "poll_ballot_boxes_tenant_id_poll_id_fkey"
  FOREIGN KEY ("tenant_id", "poll_id") REFERENCES "polls"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "poll_ballot_boxes" ADD CONSTRAINT "poll_ballot_boxes_is_object"
  CHECK (jsonb_typeof("ballots") = 'object');

-- A unit took part in a poll that has closed. Written at the close, for
-- every unit at once; never what it chose. Append-only.
CREATE TABLE "poll_participations" (
    "tenant_id" UUID NOT NULL,
    "poll_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    CONSTRAINT "poll_participations_pkey" PRIMARY KEY ("tenant_id", "poll_id", "unit_id")
);
ALTER TABLE "poll_participations"
  ADD CONSTRAINT "poll_participations_tenant_id_poll_id_fkey"
  FOREIGN KEY ("tenant_id", "poll_id") REFERENCES "polls"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "poll_participations_tenant_id_unit_id_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TRIGGER poll_participations_immutable_rows
  BEFORE UPDATE OR DELETE ON "poll_participations"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER poll_participations_immutable_truncate
  BEFORE TRUNCATE ON "poll_participations"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Privileges and RLS. Options are replaced while a poll has not opened; a
-- ballot box is deleted when its poll ends.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "polls", "poll_options", "poll_ballot_boxes", "poll_participations" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "polls" TO jiwar_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "poll_options", "poll_ballot_boxes" TO jiwar_app;
GRANT SELECT, INSERT ON "poll_participations" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['polls', 'poll_options', 'poll_ballot_boxes', 'poll_participations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
