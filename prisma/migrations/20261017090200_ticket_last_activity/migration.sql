-- ============================================================================
-- A ticket's last activity (ADR 0039): what "all my requests" orders a
-- resident's maintenance tickets by, beside their management requests.
--
-- Activity is what a resident on the ticket can see happen: a change of
-- status or cycle, a message that is not a staff note, a photo. The column
-- is kept by triggers, so no maintenance code changes and no path can
-- forget it:
--   - a new ticket starts at its created_at;
--   - a status or cycle change moves it to the database's clock;
--   - a non-internal message and an attachment move it to their created_at.
-- It only ever moves forward (GREATEST).
--
-- Locks: the two insert triggers update the ticket's row. Every path that
-- inserts a ticket message or attachment already holds that row's lock
-- (MessagesService.post and the confirmation's note under
-- TicketAccess.load(lock), AttachmentsService under the same, a new ticket's
-- photos in the transaction that inserted the ticket), so the update never
-- waits and adds no new lock order.
--
-- tickets_request_is_immutable() guards four other columns: this one is
-- free to change.
-- ============================================================================

ALTER TABLE "tickets" ADD COLUMN "last_activity_at" TIMESTAMPTZ(3);

-- Existing tickets: the latest of what counts as activity. FORCE RLS applies
-- to the owner too: one compound at a time.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', t."id"::text, true);
    UPDATE "tickets" k
       SET "last_activity_at" = GREATEST(
             k."created_at",
             COALESCE((SELECT max(h."created_at") FROM "ticket_status_history" h
                        WHERE h."ticket_id" = k."id"), k."created_at"),
             COALESCE((SELECT max(m."created_at") FROM "ticket_messages" m
                        WHERE m."ticket_id" = k."id" AND NOT m."internal"), k."created_at"),
             COALESCE((SELECT max(a."created_at") FROM "ticket_attachments" a
                        WHERE a."ticket_id" = k."id"), k."created_at"));
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;

ALTER TABLE "tickets"
  ALTER COLUMN "last_activity_at" SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "last_activity_at" SET NOT NULL;

-- A resident's feed: their tickets, most recently active first.
CREATE INDEX "tickets_tenant_id_last_activity_idx"
  ON "tickets"("tenant_id", "last_activity_at" DESC, "id" DESC);

CREATE FUNCTION tickets_touch_activity() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."last_activity_at" := NEW."created_at";
  ELSIF NEW."status" IS DISTINCT FROM OLD."status"
     OR NEW."cycle" IS DISTINCT FROM OLD."cycle" THEN
    NEW."last_activity_at" := GREATEST(
      OLD."last_activity_at", date_trunc('milliseconds', clock_timestamp()));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tickets_activity
  BEFORE INSERT OR UPDATE ON "tickets"
  FOR EACH ROW EXECUTE FUNCTION tickets_touch_activity();

-- A staff note is not activity a resident sees: it moves nothing.
CREATE FUNCTION ticket_message_touches_ticket() RETURNS trigger AS $$
BEGIN
  IF NOT NEW."internal" THEN
    UPDATE "tickets"
       SET "last_activity_at" = GREATEST("last_activity_at", NEW."created_at")
     WHERE "tenant_id" = NEW."tenant_id" AND "id" = NEW."ticket_id";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ticket_messages_activity
  AFTER INSERT ON "ticket_messages"
  FOR EACH ROW EXECUTE FUNCTION ticket_message_touches_ticket();

CREATE FUNCTION ticket_attachment_touches_ticket() RETURNS trigger AS $$
BEGIN
  UPDATE "tickets"
     SET "last_activity_at" = GREATEST("last_activity_at", NEW."created_at")
   WHERE "tenant_id" = NEW."tenant_id" AND "id" = NEW."ticket_id";
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ticket_attachments_activity
  AFTER INSERT ON "ticket_attachments"
  FOR EACH ROW EXECUTE FUNCTION ticket_attachment_touches_ticket();
