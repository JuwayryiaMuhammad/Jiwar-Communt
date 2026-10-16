-- ============================================================================
-- Phase R7a — the board's decisions and minutes (ADR 0051). Each is an
-- announcement of kind `board` to the owners (its words, versions and PDF
-- are the announcement's) and governance's record of it: which kind, the
-- board that published it, the day it was decided. An announcement of kind
-- `board` exists exactly when a publication names it: the staff's own
-- announcements never take that kind.
-- ============================================================================

CREATE TABLE "board_publications" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "term_id" UUID NOT NULL,
    "announcement_id" UUID NOT NULL,
    "decided_on" DATE NOT NULL,
    "author_side" TEXT NOT NULL,
    "published_by_account_id" UUID NOT NULL,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "board_publications_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "board_publications_tenant_id_id_key" ON "board_publications"("tenant_id", "id");
CREATE UNIQUE INDEX "board_publications_announcement_key" ON "board_publications"("tenant_id", "announcement_id");
CREATE INDEX "board_publications_created_idx" ON "board_publications"("tenant_id", "created_at", "id");
ALTER TABLE "board_publications"
  ADD CONSTRAINT "board_publications_tenant_id_term_id_fkey"
  FOREIGN KEY ("tenant_id", "term_id") REFERENCES "board_terms"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "board_publications_tenant_id_announcement_id_fkey"
  FOREIGN KEY ("tenant_id", "announcement_id") REFERENCES "announcements"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "board_publications_tenant_id_published_by_fkey"
  FOREIGN KEY ("tenant_id", "published_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "board_publications" ADD CONSTRAINT "board_publications_kind"
  CHECK ("kind" IN ('decision', 'minutes'));
ALTER TABLE "board_publications" ADD CONSTRAINT "board_publications_author_side"
  CHECK ("author_side" IN ('manager', 'board'));

-- A publication is archived once; nothing else of it changes.
CREATE FUNCTION board_publication_moves() RETURNS trigger
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
     AND (NEW."archived_at" IS NOT DISTINCT FROM OLD."archived_at"
          OR OLD."archived_at" IS NULL) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'board_publications: a publication is only archived, once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER board_publications_moves
  BEFORE UPDATE OR DELETE ON "board_publications"
  FOR EACH ROW EXECUTE FUNCTION board_publication_moves();
CREATE TRIGGER board_publications_immutable_truncate
  BEFORE TRUNCATE ON "board_publications"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- At commit: an announcement is the board's exactly when a publication
-- names it.
CREATE FUNCTION board_announcement_matches() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  a uuid;
  is_board boolean;
  named integer;
BEGIN
  IF TG_TABLE_NAME = 'announcements' THEN
    a := NEW."id";
  ELSE
    a := NEW."announcement_id";
  END IF;
  SELECT x."kind" = 'board' INTO is_board
    FROM "announcements" x WHERE x."tenant_id" = NEW."tenant_id" AND x."id" = a;
  SELECT count(*) INTO named
    FROM "board_publications" p WHERE p."tenant_id" = NEW."tenant_id" AND p."announcement_id" = a;
  IF is_board <> (named = 1) THEN
    RAISE EXCEPTION 'announcement %: of kind board (%) exactly when a board publication names it (% found)', a, is_board, named
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER announcements_board_publication
  AFTER INSERT ON "announcements" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."kind" = 'board')
  EXECUTE FUNCTION board_announcement_matches();
CREATE CONSTRAINT TRIGGER announcements_board_kind_kept
  AFTER UPDATE OF "kind" ON "announcements" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (OLD."kind" IS DISTINCT FROM NEW."kind")
  EXECUTE FUNCTION board_announcement_matches();
CREATE CONSTRAINT TRIGGER board_publications_announcement
  AFTER INSERT ON "board_publications" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION board_announcement_matches();

REVOKE ALL ON "board_publications" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "board_publications" TO jiwar_app;
ALTER TABLE "board_publications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "board_publications" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "board_publications"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
