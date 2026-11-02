-- ============================================================================
-- The field team (ADR 0078): a technician's call for help.
-- ============================================================================
--
-- A technician asks for help: more hands, someone who knows the fault,
-- parts, or a second person for safety, about one of their tickets or none.
-- Whoever runs the field team (`field_team.manage`) takes it, naming another
-- technician to send or none; the requester or the one who took it marks it
-- resolved, and the requester may call it off. One live call per
-- technician. A call nobody took in fifteen minutes is escalated to the
-- managers, once. The note is the technician's own words and staff-only.
-- Nothing is deleted; a call moves forward only.

CREATE TABLE "technician_help_requests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "requester_account_id" UUID NOT NULL,
    "kind" "technician_help_kind" NOT NULL,
    "ticket_id" UUID,
    "note" TEXT,
    "status" "technician_help_status" NOT NULL DEFAULT 'open',
    "taken_by_account_id" UUID,
    "taken_at" TIMESTAMPTZ(3),
    "helper_account_id" UUID,
    "escalated_at" TIMESTAMPTZ(3),
    "resolved_at" TIMESTAMPTZ(3),
    "resolved_by_account_id" UUID,
    "cancelled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "technician_help_requests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "technician_help_requests_tenant_id_id_key"
  ON "technician_help_requests" ("tenant_id", "id");
-- One live call per technician.
CREATE UNIQUE INDEX "technician_help_requests_one_live_key"
  ON "technician_help_requests" ("tenant_id", "requester_account_id")
  WHERE "status" IN ('open', 'taken');
CREATE INDEX "technician_help_requests_status_idx"
  ON "technician_help_requests" ("tenant_id", "status", "created_at", "id");

ALTER TABLE "technician_help_requests"
  ADD CONSTRAINT "technician_help_requests_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "technician_help_requests_tenant_id_requester_account_id_fkey"
    FOREIGN KEY ("tenant_id", "requester_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "technician_help_requests_tenant_id_ticket_id_fkey"
    FOREIGN KEY ("tenant_id", "ticket_id") REFERENCES "tickets"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "technician_help_requests_tenant_id_taken_by_account_id_fkey"
    FOREIGN KEY ("tenant_id", "taken_by_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "technician_help_requests_tenant_id_helper_account_id_fkey"
    FOREIGN KEY ("tenant_id", "helper_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "technician_help_requests_tenant_id_resolved_by_account_id_fkey"
    FOREIGN KEY ("tenant_id", "resolved_by_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "technician_help_requests"
  ADD CONSTRAINT "technician_help_requests_note_length"
    CHECK ("note" IS NULL OR char_length("note") BETWEEN 1 AND 500),
  -- Each status carries exactly its facts.
  ADD CONSTRAINT "technician_help_requests_status_shape"
    CHECK (("status" = 'open'
            AND "taken_at" IS NULL AND "taken_by_account_id" IS NULL
            AND "helper_account_id" IS NULL
            AND "resolved_at" IS NULL AND "resolved_by_account_id" IS NULL
            AND "cancelled_at" IS NULL)
        OR ("status" = 'taken'
            AND "taken_at" IS NOT NULL AND "taken_by_account_id" IS NOT NULL
            AND "resolved_at" IS NULL AND "resolved_by_account_id" IS NULL
            AND "cancelled_at" IS NULL)
        OR ("status" = 'resolved'
            AND "taken_at" IS NOT NULL AND "taken_by_account_id" IS NOT NULL
            AND "resolved_at" IS NOT NULL AND "resolved_by_account_id" IS NOT NULL
            AND "cancelled_at" IS NULL)
        OR ("status" = 'cancelled'
            AND "resolved_at" IS NULL AND "resolved_by_account_id" IS NULL
            AND "cancelled_at" IS NOT NULL
            AND ("taken_at" IS NULL) = ("taken_by_account_id" IS NULL))),
  -- Help comes from someone else.
  ADD CONSTRAINT "technician_help_requests_helper_not_requester"
    CHECK ("helper_account_id" IS NULL OR "helper_account_id" <> "requester_account_id"),
  ADD CONSTRAINT "technician_help_requests_taker_not_requester"
    CHECK ("taken_by_account_id" IS NULL OR "taken_by_account_id" <> "requester_account_id"),
  -- Escalated once, while nobody had taken it.
  ADD CONSTRAINT "technician_help_requests_escalated_before_taken"
    CHECK ("escalated_at" IS NULL OR "taken_at" IS NULL OR "escalated_at" <= "taken_at");

-- A call keeps who asked, what for and about what; it is taken once,
-- resolved or called off once, escalated once. The caller's note is
-- cleared once when they are erased, whatever the status, and nothing else
-- changes with it.
CREATE FUNCTION technician_help_request_moves_forward() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD."note" IS NOT NULL AND NEW."note" IS NULL
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."requester_account_id" = OLD."requester_account_id"
     AND NEW."kind" = OLD."kind"
     AND NEW."ticket_id" IS NOT DISTINCT FROM OLD."ticket_id"
     AND NEW."status" = OLD."status"
     AND NEW."taken_at" IS NOT DISTINCT FROM OLD."taken_at"
     AND NEW."taken_by_account_id" IS NOT DISTINCT FROM OLD."taken_by_account_id"
     AND NEW."helper_account_id" IS NOT DISTINCT FROM OLD."helper_account_id"
     AND NEW."escalated_at" IS NOT DISTINCT FROM OLD."escalated_at"
     AND NEW."resolved_at" IS NOT DISTINCT FROM OLD."resolved_at"
     AND NEW."resolved_by_account_id" IS NOT DISTINCT FROM OLD."resolved_by_account_id"
     AND NEW."cancelled_at" IS NOT DISTINCT FROM OLD."cancelled_at"
     AND NEW."created_at" = OLD."created_at" THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."requester_account_id" = OLD."requester_account_id"
     AND NEW."kind" = OLD."kind"
     AND NEW."ticket_id" IS NOT DISTINCT FROM OLD."ticket_id"
     AND NEW."note" IS NOT DISTINCT FROM OLD."note"
     AND NEW."created_at" = OLD."created_at"
     AND OLD."status" IN ('open', 'taken')
     AND (NEW."status" = OLD."status"
          OR (OLD."status" = 'open' AND NEW."status" IN ('taken', 'cancelled'))
          OR (OLD."status" = 'taken' AND NEW."status" IN ('resolved', 'cancelled')))
     AND ((NEW."taken_at" IS NOT DISTINCT FROM OLD."taken_at"
           AND NEW."taken_by_account_id" IS NOT DISTINCT FROM OLD."taken_by_account_id"
           AND NEW."helper_account_id" IS NOT DISTINCT FROM OLD."helper_account_id")
          OR OLD."status" = 'open')
     AND (NEW."escalated_at" IS NOT DISTINCT FROM OLD."escalated_at"
          OR (OLD."escalated_at" IS NULL AND OLD."status" = 'open')) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'technician_help_requests: a call keeps what it asks, moves forward only and is never deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER technician_help_requests_move_forward
  BEFORE UPDATE OR DELETE ON "technician_help_requests"
  FOR EACH ROW EXECUTE FUNCTION technician_help_request_moves_forward();
CREATE TRIGGER technician_help_requests_move_forward_truncate
  BEFORE TRUNCATE ON "technician_help_requests"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "technician_help_requests" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "technician_help_requests" TO jiwar_app;

ALTER TABLE "technician_help_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "technician_help_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "technician_help_requests"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
