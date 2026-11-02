-- ============================================================================
-- Ownership transfer requests (ADR 0083)
-- ============================================================================
--
-- The management (`residents.manage`) asks for a unit to change hands: the
-- buyer (an active resident account), whether they will live there, and the
-- household's end (REASON_CODES.householdEnd, ADR 0021) with the words the
-- leaving occupants are told (the management's, never in the audit trail).
-- One waits per unit. It is approved once — the dues gate, then the
-- transfer itself, ADR 0021's — or cancelled once, with a code.
--
-- Approved while the unit owed: what it owed then and the exception's code
-- (REASON_CODES.transferDuesException), given with a step-up. Approved with
-- nothing owed: the amount "0.00" and no code.

CREATE TABLE "ownership_transfers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "unit_id" UUID NOT NULL,
    "buyer_account_id" UUID NOT NULL,
    "resides" BOOLEAN NOT NULL,
    "reason_code" TEXT NOT NULL,
    "reason_text" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requested_by" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(3) NOT NULL,
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "owed_at_approval" DECIMAL(12,2),
    "dues_exception_code" TEXT,
    "new_occupancy_id" UUID,
    "cancel_reason" TEXT,
    CONSTRAINT "ownership_transfers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ownership_transfers_tenant_id_id_key" ON "ownership_transfers"("tenant_id", "id");
CREATE UNIQUE INDEX "ownership_transfers_number_key" ON "ownership_transfers"("tenant_id", "number");
CREATE UNIQUE INDEX "ownership_transfers_one_pending_per_unit"
  ON "ownership_transfers"("tenant_id", "unit_id") WHERE "status" = 'pending';
CREATE INDEX "ownership_transfers_list_idx"
  ON "ownership_transfers"("tenant_id", "requested_at" DESC, "id" DESC);
CREATE INDEX "ownership_transfers_unit_idx"
  ON "ownership_transfers"("tenant_id", "unit_id", "requested_at" DESC);
ALTER TABLE "ownership_transfers"
  ADD CONSTRAINT "ownership_transfers_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ownership_transfers_unit_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ownership_transfers_buyer_fkey"
  FOREIGN KEY ("tenant_id", "buyer_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ownership_transfers_requested_by_fkey"
  FOREIGN KEY ("tenant_id", "requested_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ownership_transfers_decided_by_fkey"
  FOREIGN KEY ("tenant_id", "decided_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ownership_transfers_new_occupancy_fkey"
  FOREIGN KEY ("tenant_id", "new_occupancy_id") REFERENCES "unit_occupancies"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ownership_transfers" ADD CONSTRAINT "ownership_transfers_codes"
  CHECK ("reason_code" IN ('unit_changed_hands', 'household_left', 'other')
     AND char_length("reason_text") BETWEEN 1 AND 1000);
-- Pending: nobody decided it. Done: decided, with what was owed, the new
-- occupancy, and an exception's code exactly when something was owed.
-- Cancelled: decided, with its code, and nothing of a transfer.
ALTER TABLE "ownership_transfers" ADD CONSTRAINT "ownership_transfers_state_shape"
  CHECK ("status" IN ('pending', 'done', 'cancelled')
     AND (("status" = 'pending') = ("decided_at" IS NULL))
     AND (("decided_at" IS NULL) = ("decided_by" IS NULL))
     AND (("status" = 'done') = ("owed_at_approval" IS NOT NULL))
     AND (("status" = 'done') = ("new_occupancy_id" IS NOT NULL))
     AND (("status" = 'cancelled') = ("cancel_reason" IS NOT NULL))
     AND ("owed_at_approval" IS NULL OR "owed_at_approval" >= 0)
     AND ("dues_exception_code" IS NULL
          OR ("owed_at_approval" IS NOT NULL AND "owed_at_approval" > 0
              AND "dues_exception_code" IN ('dues_settled_at_sale', 'payment_plan_agreed',
                'dues_disputed', 'court_order', 'other')))
     AND ("owed_at_approval" IS NULL OR "owed_at_approval" = 0
          OR "dues_exception_code" IS NOT NULL)
     AND ("cancel_reason" IS NULL OR "cancel_reason" IN ('sale_cancelled',
           'documents_missing', 'raised_in_error', 'other')));

-- Decided once: a pending request changes only into its decision, and a
-- decided one never changes. Never deleted.
CREATE FUNCTION "ownership_transfers_decided_once"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."status" = 'pending' AND NEW."status" <> 'pending'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."number" = OLD."number" AND NEW."unit_id" = OLD."unit_id"
     AND NEW."buyer_account_id" = OLD."buyer_account_id"
     AND NEW."resides" = OLD."resides"
     AND NEW."reason_code" = OLD."reason_code"
     AND NEW."reason_text" = OLD."reason_text"
     AND NEW."requested_by" = OLD."requested_by"
     AND NEW."requested_at" = OLD."requested_at" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ownership_transfers: a transfer is decided once, and never deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER "ownership_transfers_decided_once"
  BEFORE UPDATE OR DELETE ON "ownership_transfers"
  FOR EACH ROW EXECUTE FUNCTION "ownership_transfers_decided_once"();
CREATE TRIGGER "ownership_transfers_no_truncate"
  BEFORE TRUNCATE ON "ownership_transfers"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "ownership_transfers" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "ownership_transfers" TO jiwar_app;
ALTER TABLE "ownership_transfers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ownership_transfers" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ownership_transfers"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
