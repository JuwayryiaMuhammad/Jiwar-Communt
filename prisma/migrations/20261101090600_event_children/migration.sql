-- ============================================================================
-- Children (ADR 0054, amends ADR 0040): events for children.
-- ============================================================================
--
-- An event may be for children, of an age range (0 to 17, both ends
-- included, on the event's local start day). The household — its primary
-- or a `household` delegate — registers its minors by membership; each
-- registration is a seat, counted with the answers under the event's row
-- lock. Fixed once written, like the audience. A registration is deleted
-- when it is taken back before the start, when the child leaves the
-- household, and with the account that made it at its erasure.

ALTER TABLE "community_events"
  ADD COLUMN "for_children" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "child_age_min" INTEGER,
  ADD COLUMN "child_age_max" INTEGER;

ALTER TABLE "community_events"
  ADD CONSTRAINT "community_events_children"
    CHECK (("for_children" AND "child_age_min" IS NOT NULL AND "child_age_max" IS NOT NULL
            AND "child_age_min" BETWEEN 0 AND 17 AND "child_age_max" BETWEEN 0 AND 17
            AND "child_age_min" <= "child_age_max")
           OR (NOT "for_children" AND "child_age_min" IS NULL AND "child_age_max" IS NULL));

CREATE TABLE "event_child_registrations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "registered_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_child_registrations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "event_child_registrations_tenant_id_id_key"
  ON "event_child_registrations"("tenant_id", "id");
-- A child is registered once per event.
CREATE UNIQUE INDEX "event_child_registrations_once"
  ON "event_child_registrations"("tenant_id", "event_id", "member_id");
CREATE INDEX "event_child_registrations_member_idx"
  ON "event_child_registrations"("tenant_id", "member_id");
CREATE INDEX "event_child_registrations_by_idx"
  ON "event_child_registrations"("tenant_id", "registered_by_account_id");

ALTER TABLE "event_child_registrations"
  ADD CONSTRAINT "event_child_registrations_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "event_child_registrations_tenant_id_event_id_fkey"
    FOREIGN KEY ("tenant_id", "event_id") REFERENCES "community_events"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "event_child_registrations_tenant_id_unit_id_fkey"
    FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "event_child_registrations_tenant_id_member_id_fkey"
    FOREIGN KEY ("tenant_id", "member_id") REFERENCES "household_members"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "event_child_registrations_tenant_id_registered_by_account_id_fkey"
    FOREIGN KEY ("tenant_id", "registered_by_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Added and taken back, never changed.
CREATE TRIGGER event_child_registrations_immutable
  BEFORE UPDATE ON "event_child_registrations"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "event_child_registrations" FROM jiwar_app;
GRANT SELECT, INSERT, DELETE ON "event_child_registrations" TO jiwar_app;

ALTER TABLE "event_child_registrations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "event_child_registrations" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "event_child_registrations"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
