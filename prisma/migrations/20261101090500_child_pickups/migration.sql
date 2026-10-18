-- ============================================================================
-- Children (ADR 0054): a child's exits at the gate, and the alerts.
-- ============================================================================
--
-- The one exception to "a resident's movements are never logged" (ADR
-- 0031), and only for children whose exit control is on: each exit a guard
-- on shift records — collected by an escort, left alone, refused — with how
-- the escort was known, at which post and by which guard. A refusal is an
-- alert. The household reads its own; the management sees an unauthorized
-- pickup through its alert only. Every row is deleted 30 days after it was
-- recorded; nothing else ever changes or deletes one. The audit trail names
-- the record only, never the child, the unit or the control.

CREATE TYPE "child_pickup_outcome" AS ENUM ('picked_up', 'left_alone', 'refused', 'alone_refused');
CREATE TYPE "child_pickup_method" AS ENUM (
  'resident_qr', 'worker_qr', 'worker_code', 'pickup_qr', 'pickup_code', 'alone', 'unidentified'
);

CREATE TABLE "child_pickups" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "control_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "escort_id" UUID,
    "escort_kind" "child_escort_kind",
    "outcome" "child_pickup_outcome" NOT NULL,
    "method" "child_pickup_method" NOT NULL,
    "refusal_reason" TEXT,
    "guard_account_id" UUID NOT NULL,
    "shift_id" UUID NOT NULL,
    "gate_id" UUID,
    "place_id" UUID,
    "at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "child_pickups_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "child_pickups_tenant_id_id_key" ON "child_pickups"("tenant_id", "id");
CREATE INDEX "child_pickups_control_idx" ON "child_pickups"("tenant_id", "control_id", "at");
CREATE INDEX "child_pickups_unit_idx" ON "child_pickups"("tenant_id", "unit_id", "at", "id");
CREATE INDEX "child_pickups_age_idx" ON "child_pickups"("tenant_id", "at");
-- The keepers' alerts: unauthorized pickups only.
CREATE INDEX "child_pickups_alerts_idx" ON "child_pickups"("tenant_id", "at", "id")
  WHERE "outcome" = 'refused';

ALTER TABLE "child_pickups"
  ADD CONSTRAINT "child_pickups_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  -- The control, and its unit with it: no key on a unit's row.
  ADD CONSTRAINT "child_pickups_control_fkey"
    FOREIGN KEY ("tenant_id", "control_id", "unit_id") REFERENCES "child_controls"("tenant_id", "id", "unit_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "child_pickups_tenant_id_escort_id_fkey"
    FOREIGN KEY ("tenant_id", "escort_id") REFERENCES "child_escorts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "child_pickups_tenant_id_guard_account_id_fkey"
    FOREIGN KEY ("tenant_id", "guard_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "child_pickups_tenant_id_shift_id_fkey"
    FOREIGN KEY ("tenant_id", "shift_id") REFERENCES "guard_shifts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "child_pickups_tenant_id_gate_id_fkey"
    FOREIGN KEY ("tenant_id", "gate_id") REFERENCES "gates"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "child_pickups_tenant_id_place_id_fkey"
    FOREIGN KEY ("tenant_id", "place_id") REFERENCES "places"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "child_pickups"
  -- At the post of the guard's shift: a gate or a zone.
  ADD CONSTRAINT "child_pickups_one_post"
    CHECK (num_nonnulls("gate_id", "place_id") = 1),
  -- A refusal has a reason, and nothing else does.
  ADD CONSTRAINT "child_pickups_refusal_shape"
    CHECK (("outcome" IN ('refused', 'alone_refused')) = ("refusal_reason" IS NOT NULL)),
  ADD CONSTRAINT "child_pickups_refusal_reason"
    CHECK ("refusal_reason" IS NULL OR "refusal_reason" IN (
      'not_an_escort', 'outside_validity', 'wrong_post', 'escort_inactive',
      'no_credential', 'alone_not_allowed')),
  -- Alone means left alone or held; an escort collected the child or was
  -- refused for this child; the unidentified are refused.
  ADD CONSTRAINT "child_pickups_method_shape"
    CHECK (("method" = 'alone') = ("outcome" IN ('left_alone', 'alone_refused'))
           AND ("method" <> 'unidentified' OR "outcome" = 'refused')),
  ADD CONSTRAINT "child_pickups_escort_shape"
    CHECK (("escort_id" IS NULL) = ("escort_kind" IS NULL)
           AND ("outcome" <> 'picked_up' OR "escort_id" IS NOT NULL)
           AND ("escort_id" IS NULL OR "outcome" IN ('picked_up', 'refused')));

-- Never changed; deleted only by the 30-day purge (the app's DELETE).
CREATE TRIGGER child_pickups_immutable
  BEFORE UPDATE ON "child_pickups"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER child_pickups_immutable_truncate
  BEFORE TRUNCATE ON "child_pickups"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "child_pickups" FROM jiwar_app;
GRANT SELECT, INSERT, DELETE ON "child_pickups" TO jiwar_app;

ALTER TABLE "child_pickups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "child_pickups" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "child_pickups"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
