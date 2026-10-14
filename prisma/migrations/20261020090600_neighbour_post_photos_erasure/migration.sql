-- ============================================================================
-- Neighbours (ADR 0042): an erased post photo takes its row with it.
--
-- An erasure deletes the photos of the posts its account wrote. The file is
-- marked deleted in the erasure's transaction and its object and row go
-- after the commit — but the photo row kept pointing at the file (ON DELETE
-- RESTRICT), so the file's row could never be deleted. The files sweep then
-- found it on every run, deleted the (already gone) object and walked every
-- compound a second time to delete the row, failing again: one stuck file
-- doubled the cost of every sweep, for good.
--
-- A photo row is now deleted with its file, by the erasure: the trigger
-- lets a DELETE through only when the row's file is already marked deleted,
-- and refuses every UPDATE and TRUNCATE as before. A live photo is still
-- never deleted.
-- ============================================================================

CREATE FUNCTION neighbour_post_photo_goes_with_its_file() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND EXISTS (
       SELECT 1 FROM "files" f
        WHERE f."tenant_id" = OLD."tenant_id" AND f."id" = OLD."file_id"
          AND f."deleted_at" IS NOT NULL) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'neighbour_post_photos: a photo goes only with its deleted file (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER neighbour_post_photos_immutable_rows ON "neighbour_post_photos";
CREATE TRIGGER neighbour_post_photos_immutable_update
  BEFORE UPDATE ON "neighbour_post_photos"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER neighbour_post_photos_goes_with_file
  BEFORE DELETE ON "neighbour_post_photos"
  FOR EACH ROW EXECUTE FUNCTION neighbour_post_photo_goes_with_its_file();

GRANT DELETE ON "neighbour_post_photos" TO jiwar_app;
