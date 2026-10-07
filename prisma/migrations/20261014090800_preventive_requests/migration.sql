-- ============================================================================
-- Preventive maintenance requests (ADR 0038): a resident books a check-up
-- (a preventive service) for a window. It is a ticket like any other, of
-- kind `preventive`, that names its service and the window asked for. When a
-- technician takes it, the window is proposed as a visit from the
-- residents' side.
--
-- Every existing ticket is a `repair` (the default fills the rows).
-- ============================================================================

CREATE TYPE "ticket_kind" AS ENUM ('repair', 'preventive');

ALTER TABLE "tickets"
  ADD COLUMN "kind" "ticket_kind" NOT NULL DEFAULT 'repair',
  ADD COLUMN "preventive_service_id" UUID,
  ADD COLUMN "requested_starts_at" TIMESTAMPTZ(3),
  ADD COLUMN "requested_ends_at" TIMESTAMPTZ(3);

ALTER TABLE "tickets" ADD CONSTRAINT "tickets_tenant_id_preventive_service_id_fkey"
  FOREIGN KEY ("tenant_id", "preventive_service_id")
  REFERENCES "preventive_services"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- A preventive ticket has its service and its window, a repair has neither;
-- and a check-up is always in a unit. `kind` is NOT NULL, so each side of
-- every `=` is a real boolean.
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_preventive_shape"
  CHECK (("kind" = 'preventive') = ("preventive_service_id" IS NOT NULL)
     AND ("kind" = 'preventive') = ("requested_starts_at" IS NOT NULL)
     AND ("kind" = 'preventive') = ("requested_ends_at" IS NOT NULL)
     AND ("kind" <> 'preventive' OR "unit_id" IS NOT NULL));
-- Like a visit's window (ADR 0034): the end after the start, at most four
-- hours later. Both are NULL together (above), and then this passes.
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_requested_window"
  CHECK ("requested_ends_at" > "requested_starts_at"
     AND "requested_ends_at" <= "requested_starts_at" + interval '4 hours');

-- The note of a preventive request is optional, so only a preventive ticket
-- may have no description. The 5.1 length CHECK (1 to 2000) still holds for
-- every description there is.
ALTER TABLE "tickets" ALTER COLUMN "description" DROP NOT NULL;
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_description_unless_preventive"
  CHECK ("kind" = 'preventive' OR "description" IS NOT NULL);

-- What was asked for is a fact of the request: no path changes a ticket's
-- kind, its service or its requested window, and none may. For every role.
CREATE FUNCTION tickets_request_is_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."preventive_service_id" IS DISTINCT FROM OLD."preventive_service_id"
     OR NEW."requested_starts_at" IS DISTINCT FROM OLD."requested_starts_at"
     OR NEW."requested_ends_at" IS DISTINCT FROM OLD."requested_ends_at" THEN
    RAISE EXCEPTION 'a ticket''s kind and request never change'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tickets_request_immutable
  BEFORE UPDATE ON "tickets"
  FOR EACH ROW EXECUTE FUNCTION tickets_request_is_immutable();
