-- ============================================================================
-- Suggestions, the public board, and "you said, we did" (ADR 0040).
--
-- Personal data here: `suggestions.body`, the resident's own words, private
-- to its author and the staff. An erasure clears it and nothing else; the
-- row stays, pointing at the tombstone (the rule of a management request's
-- messages, ADR 0039). Everything else written here is the staff's: the
-- answer, the public summary a published suggestion is shown by (never the
-- resident's text, never their identity), and the "we did" note.
-- `suggestion_supports` says which account supports a published
-- suggestion; an erasure deletes its account's rows.
-- ============================================================================

CREATE TYPE "suggestion_status" AS ENUM ('received', 'under_review', 'planned', 'done', 'declined');

CREATE TABLE "suggestions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "author_account_id" UUID NOT NULL,
    "unit_id" UUID,
    "topic_id" UUID NOT NULL,
    "body" TEXT,
    "erased_at" TIMESTAMPTZ(3),
    "status" "suggestion_status" NOT NULL DEFAULT 'received',
    "response" TEXT,
    "responded_at" TIMESTAMPTZ(3),
    "published_at" TIMESTAMPTZ(3),
    "public_title_en" TEXT,
    "public_text_en" TEXT,
    "public_title_ar" TEXT,
    "public_text_ar" TEXT,
    "done_at" TIMESTAMPTZ(3),
    "done_note_en" TEXT,
    "done_note_ar" TEXT,
    "done_attachment_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "suggestions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "suggestions_tenant_id_id_key" ON "suggestions"("tenant_id", "id");
CREATE INDEX "suggestions_author_idx" ON "suggestions"("tenant_id", "author_account_id", "created_at", "id");
CREATE INDEX "suggestions_created_idx" ON "suggestions"("tenant_id", "created_at", "id");
CREATE INDEX "suggestions_board_idx" ON "suggestions"("tenant_id", "published_at", "id");
CREATE INDEX "suggestions_done_idx" ON "suggestions"("tenant_id", "done_at", "id");
ALTER TABLE "suggestions"
  ADD CONSTRAINT "suggestions_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "suggestions_tenant_id_author_fkey"
  FOREIGN KEY ("tenant_id", "author_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "suggestions_tenant_id_unit_id_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "suggestions_tenant_id_topic_id_fkey"
  FOREIGN KEY ("tenant_id", "topic_id") REFERENCES "suggestion_topics"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- The resident's words are there, or erased.
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_body_or_erased"
  CHECK (("body" IS NULL) = ("erased_at" IS NOT NULL));
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_lengths"
  CHECK (("body" IS NULL OR char_length("body") BETWEEN 1 AND 2000)
     AND ("response" IS NULL OR char_length("response") BETWEEN 1 AND 2000)
     AND ("public_title_en" IS NULL OR char_length("public_title_en") BETWEEN 1 AND 150)
     AND ("public_title_ar" IS NULL OR char_length("public_title_ar") BETWEEN 1 AND 150)
     AND ("public_text_en" IS NULL OR char_length("public_text_en") BETWEEN 1 AND 2000)
     AND ("public_text_ar" IS NULL OR char_length("public_text_ar") BETWEEN 1 AND 2000)
     AND ("done_note_en" IS NULL OR char_length("done_note_en") BETWEEN 1 AND 2000)
     AND ("done_note_ar" IS NULL OR char_length("done_note_ar") BETWEEN 1 AND 2000));
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_response_time"
  CHECK (("response" IS NULL) = ("responded_at" IS NULL));
-- On the board with a public summary, whole per language, or not at all.
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_published_summary"
  CHECK (("public_title_en" IS NULL) = ("public_text_en" IS NULL)
     AND ("public_title_ar" IS NULL) = ("public_text_ar" IS NULL)
     AND ("published_at" IS NOT NULL) = ("public_title_en" IS NOT NULL OR "public_title_ar" IS NOT NULL));
-- A "we did" note is a done suggestion's.
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_done_shape"
  CHECK (("done_at" IS NOT NULL) = ("status" = 'done')
     AND ("status" = 'done'
          OR ("done_note_en" IS NULL AND "done_note_ar" IS NULL AND cardinality("done_attachment_ids") = 0))
     AND cardinality("done_attachment_ids") <= 5);

-- What a suggestion is never rewritten in: who wrote it, about what and
-- when; and its words, which only an erasure clears, once.
CREATE FUNCTION suggestion_keeps_its_author() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."author_account_id" = OLD."author_account_id"
     AND NEW."unit_id" IS NOT DISTINCT FROM OLD."unit_id"
     AND NEW."topic_id" = OLD."topic_id"
     AND NEW."created_at" = OLD."created_at"
     AND (
       (NEW."body" IS NOT DISTINCT FROM OLD."body"
        AND NEW."erased_at" IS NOT DISTINCT FROM OLD."erased_at")
       OR (OLD."body" IS NOT NULL AND NEW."body" IS NULL
           AND OLD."erased_at" IS NULL AND NEW."erased_at" IS NOT NULL)
     ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'suggestions: a suggestion keeps its author and its words (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER suggestions_keep_author
  BEFORE UPDATE OR DELETE ON "suggestions"
  FOR EACH ROW EXECUTE FUNCTION suggestion_keeps_its_author();
CREATE TRIGGER suggestions_keep_author_truncate
  BEFORE TRUNCATE ON "suggestions"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- What happened to a suggestion: each move and each answer, in order, in
-- the staff's words. Append-only.
-- ----------------------------------------------------------------------------
CREATE TABLE "suggestion_updates" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "suggestion_id" UUID NOT NULL,
    "status" "suggestion_status" NOT NULL,
    "response" TEXT,
    "by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "suggestion_updates_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "suggestion_updates_suggestion_idx"
  ON "suggestion_updates"("tenant_id", "suggestion_id", "created_at", "id");
ALTER TABLE "suggestion_updates"
  ADD CONSTRAINT "suggestion_updates_tenant_id_suggestion_id_fkey"
  FOREIGN KEY ("tenant_id", "suggestion_id") REFERENCES "suggestions"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "suggestion_updates_tenant_id_by_fkey"
  FOREIGN KEY ("tenant_id", "by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "suggestion_updates" ADD CONSTRAINT "suggestion_updates_response_length"
  CHECK ("response" IS NULL OR char_length("response") BETWEEN 1 AND 2000);

CREATE TRIGGER suggestion_updates_immutable_rows
  BEFORE UPDATE OR DELETE ON "suggestion_updates"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER suggestion_updates_immutable_truncate
  BEFORE TRUNCATE ON "suggestion_updates"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- A photo of what was done. Append-only: the suggestion lists the ones its
-- note shows.
CREATE TABLE "suggestion_attachments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "suggestion_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "uploaded_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "suggestion_attachments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "suggestion_attachments_file_id_key" ON "suggestion_attachments"("file_id");
CREATE INDEX "suggestion_attachments_suggestion_idx"
  ON "suggestion_attachments"("tenant_id", "suggestion_id", "created_at", "id");
ALTER TABLE "suggestion_attachments"
  ADD CONSTRAINT "suggestion_attachments_tenant_id_suggestion_id_fkey"
  FOREIGN KEY ("tenant_id", "suggestion_id") REFERENCES "suggestions"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "suggestion_attachments_tenant_id_file_id_fkey"
  FOREIGN KEY ("tenant_id", "file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "suggestion_attachments_tenant_id_uploaded_by_fkey"
  FOREIGN KEY ("tenant_id", "uploaded_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TRIGGER suggestion_attachments_immutable_rows
  BEFORE UPDATE OR DELETE ON "suggestion_attachments"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER suggestion_attachments_immutable_truncate
  BEFORE TRUNCATE ON "suggestion_attachments"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- One support per account and suggestion; taken back by deleting the row.
CREATE TABLE "suggestion_supports" (
    "tenant_id" UUID NOT NULL,
    "suggestion_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    CONSTRAINT "suggestion_supports_pkey" PRIMARY KEY ("tenant_id", "suggestion_id", "account_id")
);
CREATE INDEX "suggestion_supports_account_idx" ON "suggestion_supports"("tenant_id", "account_id");
ALTER TABLE "suggestion_supports"
  ADD CONSTRAINT "suggestion_supports_tenant_id_suggestion_id_fkey"
  FOREIGN KEY ("tenant_id", "suggestion_id") REFERENCES "suggestions"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "suggestion_supports_tenant_id_account_id_fkey"
  FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ----------------------------------------------------------------------------
-- Privileges and RLS. A suggestion is never deleted; a support is.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "suggestions", "suggestion_updates", "suggestion_attachments",
  "suggestion_supports" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "suggestions" TO jiwar_app;
GRANT SELECT, INSERT ON "suggestion_updates", "suggestion_attachments" TO jiwar_app;
GRANT SELECT, INSERT, DELETE ON "suggestion_supports" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['suggestions', 'suggestion_updates', 'suggestion_attachments',
    'suggestion_supports'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
