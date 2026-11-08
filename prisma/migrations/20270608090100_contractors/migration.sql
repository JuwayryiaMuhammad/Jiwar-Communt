-- ============================================================================
-- The contractor portal (ADR 0088).
--
-- - A contractor is an account of its own kind (20270608090000), tied to one
--   vendor of the register (ADR 0077): `accounts.vendor_id`, set when it is
--   made and never changed; only a contractor has one.
-- - A ticket dispatched to a vendor (`tickets.vendor_id`) waits in the queue
--   with no technician while it is offered; a contractor of that vendor
--   takes it (and becomes its technician, through the technician's routes)
--   or turns it down. Every path by which the contractor then loses it —
--   gives it back, a reassignment, a release, a rejection sent to the queue —
--   lets the vendor go of it too, and a cancel ends an open offer: a trigger
--   keeps it, so no path can forget. The SLA clock is the ticket's own.
-- - The offers (`ticket_vendor_dispatches`): one live a ticket, forward only.
-- - A tender's documents and a bid's offer are PDFs or photos of 10 MB: the
--   content type CHECK is recreated whole with every purpose (as FILE_PURPOSES
--   in src/core/files/purposes.ts has them; a unit test keeps them in step).
-- - A vendor's invoice a contractor sends in (ADR 0089's table) comes by the
--   `contractor` channel, from a contractor of that very vendor (a trigger);
--   the office's never from a contractor.
-- - The staff inbox gathers a tender waiting to be opened: both type CHECKs
--   are recreated with it.
-- - Every recreated CHECK holds every value on main and before it here
--   (20270601090200 the inbox's last, 20270518090100 the files' last), so a
--   fresh database and an existing one both end with all of them.
-- No row of an existing table changes.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Files: the content type CHECK with the two new purposes, after ADR 0087's.
-- ----------------------------------------------------------------------------
ALTER TABLE "files" DROP CONSTRAINT "files_content_type_for_purpose";
ALTER TABLE "files" ADD CONSTRAINT "files_content_type_for_purpose"
  CHECK (("content_type" IN ('image/jpeg', 'image/png', 'image/webp') AND "purpose" NOT IN ('data_export', 'patrol_note_audio', 'patrol_note_video', 'incident_audio', 'incident_video', 'incident_signature', 'compound_document', 'data_import', 'compound_logo'))
      OR ("content_type" = 'image/png' AND "purpose" = 'incident_signature')
      OR ("content_type" IN ('image/jpeg', 'image/png') AND "purpose" = 'compound_logo')
      OR ("content_type" = 'application/pdf' AND "purpose" IN ('document', 'request_attachment', 'community_attachment', 'complaint_evidence', 'vehicle_licence', 'approval_attachment', 'board_appeal_attachment', 'expense_invoice', 'decision_appeal_attachment', 'registration_document', 'kinship_proof', 'unit_document', 'compound_document', 'contract', 'asset_document', 'vendor_document', 'permit_drawing', 'compliance_evidence', 'tender_document', 'tender_bid'))
      OR ("content_type" = 'application/zip' AND "purpose" = 'data_export')
      OR ("content_type" = 'audio/mp4' AND "purpose" IN ('patrol_note_audio', 'incident_audio'))
      OR ("content_type" IN ('video/mp4', 'video/quicktime') AND "purpose" IN ('patrol_note_video', 'incident_video'))
      OR ("content_type" = 'text/csv' AND "purpose" = 'data_import'));

-- ----------------------------------------------------------------------------
-- A contractor's vendor.
-- ----------------------------------------------------------------------------
ALTER TABLE "accounts" ADD COLUMN "vendor_id" UUID;
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_vendor_fkey"
  FOREIGN KEY ("tenant_id", "vendor_id") REFERENCES "vendors"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_contractor_vendor"
  CHECK (("type" = 'contractor') = ("vendor_id" IS NOT NULL));
CREATE INDEX "accounts_vendor_idx"
  ON "accounts"("tenant_id", "vendor_id", "status") WHERE "vendor_id" IS NOT NULL;

-- A contractor stays its vendor's: another vendor's work is another account.
CREATE FUNCTION accounts_vendor_is_fixed() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."vendor_id" IS DISTINCT FROM OLD."vendor_id" THEN
    RAISE EXCEPTION 'accounts: a contractor''s vendor never changes'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER accounts_vendor_is_fixed
  BEFORE UPDATE OF "vendor_id" ON "accounts"
  FOR EACH ROW EXECUTE FUNCTION accounts_vendor_is_fixed();

-- ----------------------------------------------------------------------------
-- A ticket's vendor: offered to it, or taken by one of its contractors.
-- ----------------------------------------------------------------------------
ALTER TABLE "tickets" ADD COLUMN "vendor_id" UUID;
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_vendor_fkey"
  FOREIGN KEY ("tenant_id", "vendor_id") REFERENCES "vendors"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE INDEX "tickets_vendor_idx"
  ON "tickets"("tenant_id", "vendor_id", "status") WHERE "vendor_id" IS NOT NULL;

-- A contractor taking an offered ticket is an assignment of type `vendor`
-- (20270608090000): to the contractor, from nobody, by the contractor. The
-- shape CHECK is recreated whole with it; the other five are as
-- 20261007090100 made them, the CHECK's only recreation.
ALTER TABLE "ticket_assignments" DROP CONSTRAINT "ticket_assignments_type_shape";
ALTER TABLE "ticket_assignments" ADD CONSTRAINT "ticket_assignments_type_shape"
  CHECK (
    ("assignment_type" = 'manual'
      AND "from_account_id" IS NULL AND "to_account_id" IS NOT NULL
      AND "assigned_by_account_id" IS NOT NULL)
    OR ("assignment_type" = 'reassignment'
      AND "from_account_id" IS NOT NULL AND "to_account_id" IS NOT NULL
      AND "from_account_id" <> "to_account_id"
      AND "assigned_by_account_id" IS NOT NULL AND "reason_code" IS NOT NULL)
    OR ("assignment_type" = 'declined'
      AND "from_account_id" IS NOT NULL AND "to_account_id" IS NULL
      AND "assigned_by_account_id" IS NOT NULL
      AND "assigned_by_account_id" = "from_account_id"
      AND "reason_code" IS NOT NULL)
    OR ("assignment_type" = 'released'
      AND "from_account_id" IS NOT NULL AND "to_account_id" IS NULL
      AND "assigned_by_account_id" IS NULL AND "reason_code" IS NOT NULL)
    OR ("assignment_type" = 'automatic'
      AND "to_account_id" IS NOT NULL AND "assigned_by_account_id" IS NULL)
    OR ("assignment_type" = 'vendor'
      AND "from_account_id" IS NULL AND "to_account_id" IS NOT NULL
      AND "assigned_by_account_id" IS NOT NULL
      AND "assigned_by_account_id" = "to_account_id")
  );

CREATE TABLE "ticket_vendor_dispatches" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "vendor_id" UUID NOT NULL,
    "cycle" INTEGER NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'offered',
    "offered_by_account_id" UUID NOT NULL,
    "offered_at" TIMESTAMPTZ(3) NOT NULL,
    "decided_by_account_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "decline_reason" TEXT,
    "withdrawn_by_account_id" UUID,
    "withdraw_reason" TEXT,
    "ended_at" TIMESTAMPTZ(3),
    CONSTRAINT "ticket_vendor_dispatches_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ticket_vendor_dispatches_tenant_id_id_key"
  ON "ticket_vendor_dispatches"("tenant_id", "id");
-- One live offer a ticket: offered, or taken and not given back.
CREATE UNIQUE INDEX "ticket_vendor_dispatches_one_live"
  ON "ticket_vendor_dispatches"("tenant_id", "ticket_id") WHERE "status" IN ('offered', 'accepted');
CREATE INDEX "ticket_vendor_dispatches_vendor_idx"
  ON "ticket_vendor_dispatches"("tenant_id", "vendor_id", "status", "offered_at" DESC, "id" DESC);
CREATE INDEX "ticket_vendor_dispatches_ticket_idx"
  ON "ticket_vendor_dispatches"("tenant_id", "ticket_id", "offered_at", "id");
ALTER TABLE "ticket_vendor_dispatches"
  ADD CONSTRAINT "ticket_vendor_dispatches_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ticket_vendor_dispatches_ticket_fkey"
  FOREIGN KEY ("tenant_id", "ticket_id") REFERENCES "tickets"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ticket_vendor_dispatches_vendor_fkey"
  FOREIGN KEY ("tenant_id", "vendor_id") REFERENCES "vendors"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ticket_vendor_dispatches_offered_by_fkey"
  FOREIGN KEY ("tenant_id", "offered_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ticket_vendor_dispatches_decided_by_fkey"
  FOREIGN KEY ("tenant_id", "decided_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ticket_vendor_dispatches_withdrawn_by_fkey"
  FOREIGN KEY ("tenant_id", "withdrawn_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ticket_vendor_dispatches" ADD CONSTRAINT "ticket_vendor_dispatches_shape"
  CHECK ("cycle" > 0
     AND ("note" IS NULL OR char_length("note") BETWEEN 1 AND 500));
-- Each state with what made it: offered → accepted (by a contractor) |
-- declined (by a contractor, with a reason) | withdrawn (by dispatch with a
-- reason, or by the system as the ticket was cancelled); accepted →
-- returned (its contractor lost it). REASON_CODES.vendorDispatchDecline and
-- .vendorDispatchWithdraw; a unit test keeps them in step.
ALTER TABLE "ticket_vendor_dispatches" ADD CONSTRAINT "ticket_vendor_dispatches_state_shape"
  CHECK ("status" IN ('offered', 'accepted', 'declined', 'withdrawn', 'returned')
     AND (("decided_at" IS NULL) = ("decided_by_account_id" IS NULL))
     AND (("status" IN ('accepted', 'declined', 'returned')) = ("decided_at" IS NOT NULL))
     AND (("status" = 'declined') = ("decline_reason" IS NOT NULL))
     AND ("decline_reason" IS NULL
          OR "decline_reason" IN ('no_capacity', 'out_of_scope', 'too_far', 'other'))
     AND (("status" IN ('withdrawn', 'returned')) = ("ended_at" IS NOT NULL))
     AND ("withdrawn_by_account_id" IS NULL OR "status" = 'withdrawn')
     AND (("withdrawn_by_account_id" IS NULL) = ("withdraw_reason" IS NULL))
     AND ("withdraw_reason" IS NULL
          OR "withdraw_reason" IN ('handled_in_house', 'vendor_unresponsive', 'not_needed', 'other')));

-- Terms fixed; forward only.
CREATE FUNCTION ticket_vendor_dispatches_move_forward() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."ticket_id" = OLD."ticket_id" AND NEW."vendor_id" = OLD."vendor_id"
     AND NEW."cycle" = OLD."cycle"
     AND NEW."note" IS NOT DISTINCT FROM OLD."note"
     AND NEW."offered_by_account_id" = OLD."offered_by_account_id"
     AND NEW."offered_at" = OLD."offered_at"
     AND ((OLD."status" = 'offered' AND NEW."status" IN ('accepted', 'declined', 'withdrawn'))
       OR (OLD."status" = 'accepted' AND NEW."status" = 'returned'
           AND NEW."decided_at" = OLD."decided_at"
           AND NEW."decided_by_account_id" = OLD."decided_by_account_id")) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ticket_vendor_dispatches: an offer keeps its terms and moves forward only (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER ticket_vendor_dispatches_move_forward
  BEFORE UPDATE OR DELETE ON "ticket_vendor_dispatches"
  FOR EACH ROW EXECUTE FUNCTION ticket_vendor_dispatches_move_forward();
CREATE TRIGGER ticket_vendor_dispatches_truncate
  BEFORE TRUNCATE ON "ticket_vendor_dispatches"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- The vendor follows its contractor. A vendor is set only on a queued
-- ticket with no technician (the offer); while it is offered, only a
-- contractor of that vendor takes it. Its contractor losing it — given
-- back, reassigned, released, sent back to the queue — lets the vendor go;
-- a cancel or a close with no technician ends the offer.
CREATE FUNCTION tickets_vendor_follows() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."vendor_id" IS NOT NULL AND NEW."vendor_id" IS NOT DISTINCT FROM OLD."vendor_id" THEN
    IF OLD."technician_account_id" IS NOT NULL
       AND NEW."technician_account_id" IS DISTINCT FROM OLD."technician_account_id" THEN
      NEW."vendor_id" := NULL;
    ELSIF OLD."technician_account_id" IS NULL AND NEW."technician_account_id" IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM "accounts" a
                      WHERE a."id" = NEW."technician_account_id"
                        AND a."vendor_id" = OLD."vendor_id") THEN
        RAISE EXCEPTION 'tickets: a ticket offered to a vendor goes to its contractors only'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF OLD."technician_account_id" IS NULL AND NEW."status" IN ('cancelled', 'closed') THEN
      NEW."vendor_id" := NULL;
    END IF;
  END IF;
  IF NEW."vendor_id" IS NOT NULL AND NEW."vendor_id" IS DISTINCT FROM OLD."vendor_id"
     AND NOT (NEW."status" = 'new' AND NEW."technician_account_id" IS NULL) THEN
    RAISE EXCEPTION 'tickets: only a queued ticket with no technician is offered to a vendor'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER tickets_vendor_follows
  BEFORE UPDATE ON "tickets"
  FOR EACH ROW EXECUTE FUNCTION tickets_vendor_follows();

-- The vendor let go: its live offer ends with it (withdrawn while offered,
-- returned once taken). An offer the app ended first (declined, withdrawn
-- by dispatch) is not live any more, so nothing changes twice.
CREATE FUNCTION tickets_vendor_released() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."vendor_id" IS NOT NULL AND NEW."vendor_id" IS NULL THEN
    UPDATE "ticket_vendor_dispatches"
       SET "status" = CASE "status" WHEN 'offered' THEN 'withdrawn' ELSE 'returned' END,
           "ended_at" = date_trunc('milliseconds', clock_timestamp())
     WHERE "tenant_id" = NEW."tenant_id" AND "ticket_id" = NEW."id"
       AND "status" IN ('offered', 'accepted');
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER tickets_vendor_released
  AFTER UPDATE ON "tickets"
  FOR EACH ROW EXECUTE FUNCTION tickets_vendor_released();

-- ----------------------------------------------------------------------------
-- A vendor's invoice by the contractor portal (amends ADR 0089's CHECK).
-- ----------------------------------------------------------------------------
ALTER TABLE "finance_vendor_invoices" DROP CONSTRAINT "finance_vendor_invoices_shape";
ALTER TABLE "finance_vendor_invoices" ADD CONSTRAINT "finance_vendor_invoices_shape"
  CHECK ("number" > 0
     AND "channel" IN ('office', 'contractor')
     AND char_length("vendor_number") BETWEEN 1 AND 60
     AND "issued_on" <= "due_on"
     AND ("note" IS NULL OR char_length("note") BETWEEN 1 AND 500)
     AND "subtotal" > 0 AND "tax" >= 0 AND "total" = "subtotal" + "tax"
     AND "total" <= 999999999.99);
CREATE INDEX "finance_vendor_invoices_channel_idx"
  ON "finance_vendor_invoices"("tenant_id", "vendor_id", "recorded_at" DESC, "id" DESC)
  WHERE "channel" = 'contractor';

-- The contractor channel's recorder is a contractor of the invoice's
-- vendor; the office's is never a contractor.
CREATE FUNCTION finance_vendor_invoices_channel() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."channel" = 'contractor' AND NOT EXISTS (
       SELECT 1 FROM "accounts" a
        WHERE a."id" = NEW."recorded_by_account_id"
          AND a."type" = 'contractor' AND a."vendor_id" = NEW."vendor_id") THEN
    RAISE EXCEPTION 'finance_vendor_invoices: a contractor sends in its own vendor''s invoices only'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."channel" = 'office' AND EXISTS (
       SELECT 1 FROM "accounts" a
        WHERE a."id" = NEW."recorded_by_account_id" AND a."type" = 'contractor') THEN
    RAISE EXCEPTION 'finance_vendor_invoices: a contractor''s invoice comes by its channel'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER finance_vendor_invoices_channel
  BEFORE INSERT ON "finance_vendor_invoices"
  FOR EACH ROW EXECUTE FUNCTION finance_vendor_invoices_channel();

-- ----------------------------------------------------------------------------
-- The staff inbox (ADR 0073) gathers a tender waiting to be opened.
-- ----------------------------------------------------------------------------
ALTER TABLE "staff_inbox_due_hours" DROP CONSTRAINT "staff_inbox_due_hours_type";
ALTER TABLE "staff_inbox_due_hours" ADD CONSTRAINT "staff_inbox_due_hours_type"
  CHECK ("type" IN ('registration', 'identity_change', 'worker_engagement', 'vehicle',
    'booking', 'unit_permit', 'work_permit', 'field_exception', 'plan_request',
    'invoice_dispute', 'decision_appeal', 'management_request', 'purchase_request', 'space_use_request',
    'plan_suggestion', 'follow_up_case', 'recovery_case', 'compensation',
    'ownership_transfer', 'closed_unit_round', 'unit_entry_report',
    'vendor_invoice', 'contract_disbursement', 'tender_opening'));
ALTER TABLE "staff_inbox_overdue" DROP CONSTRAINT "staff_inbox_overdue_type";
ALTER TABLE "staff_inbox_overdue" ADD CONSTRAINT "staff_inbox_overdue_type"
  CHECK ("type" IN ('registration', 'identity_change', 'worker_engagement', 'vehicle',
    'booking', 'unit_permit', 'work_permit', 'field_exception', 'plan_request',
    'invoice_dispute', 'decision_appeal', 'management_request', 'purchase_request', 'space_use_request',
    'plan_suggestion', 'follow_up_case', 'recovery_case', 'compensation',
    'ownership_transfer', 'closed_unit_round', 'unit_entry_report',
    'vendor_invoice', 'contract_disbursement', 'tender_opening'));

-- ----------------------------------------------------------------------------
-- Privileges and RLS.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "ticket_vendor_dispatches" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "ticket_vendor_dispatches" TO jiwar_app;
ALTER TABLE "ticket_vendor_dispatches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ticket_vendor_dispatches" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ticket_vendor_dispatches"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
