-- ============================================================================
-- Purchase requests (ADR 0077): a light request to buy what the store lacks
-- or a service, by the staff who need it, approved by the manager up to the
-- manager's limit (the major contract threshold, ADR 0055) and above it only
-- under an approved major contract of the board, which signs one request.
-- No purchase order: once bought, the request is marked fulfilled with the
-- reference of the expense or invoice that paid it. A PR- number a
-- compound. Moves forward only (a trigger); never deleted.
--
-- Its title and description are the requester's words about work, never
-- about a person: business data, not personal data.
-- ============================================================================

CREATE TABLE "purchase_requests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "vendor_id" UUID,
    "budget_line_id" UUID,
    "stock_item_id" UUID,
    "quantity" DECIMAL(12,3),
    "estimated_amount" DECIMAL(14,2) NOT NULL,
    "needed_by" DATE,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "requested_by_account_id" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(3) NOT NULL,
    "decided_by_account_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "reject_reason" TEXT,
    "decision_note" TEXT,
    "approval_request_id" UUID,
    "cancelled_by_account_id" UUID,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" TEXT,
    "fulfilled_by_account_id" UUID,
    "fulfilled_at" TIMESTAMPTZ(3),
    "fulfilled_reference" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "purchase_requests_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "purchase_requests_tenant_id_id_key" ON "purchase_requests"("tenant_id", "id");
CREATE UNIQUE INDEX "purchase_requests_number_key" ON "purchase_requests"("tenant_id", "number");
-- A board approval signs one request.
CREATE UNIQUE INDEX "purchase_requests_approval_key"
  ON "purchase_requests"("tenant_id", "approval_request_id") WHERE "approval_request_id" IS NOT NULL;
CREATE INDEX "purchase_requests_status_idx"
  ON "purchase_requests"("tenant_id", "status", "requested_at", "id");
CREATE INDEX "purchase_requests_requester_idx"
  ON "purchase_requests"("tenant_id", "requested_by_account_id", "requested_at" DESC, "id" DESC);
ALTER TABLE "purchase_requests"
  ADD CONSTRAINT "purchase_requests_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "purchase_requests_tenant_id_vendor_fkey"
  FOREIGN KEY ("tenant_id", "vendor_id") REFERENCES "vendors"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "purchase_requests_tenant_id_budget_line_fkey"
  FOREIGN KEY ("tenant_id", "budget_line_id") REFERENCES "finance_budget_lines"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "purchase_requests_tenant_id_stock_item_fkey"
  FOREIGN KEY ("tenant_id", "stock_item_id") REFERENCES "stock_items"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "purchase_requests_tenant_id_approval_fkey"
  FOREIGN KEY ("tenant_id", "approval_request_id") REFERENCES "governance_approval_requests"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "purchase_requests_tenant_id_requested_by_fkey"
  FOREIGN KEY ("tenant_id", "requested_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "purchase_requests_tenant_id_decided_by_fkey"
  FOREIGN KEY ("tenant_id", "decided_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "purchase_requests_tenant_id_cancelled_by_fkey"
  FOREIGN KEY ("tenant_id", "cancelled_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "purchase_requests_tenant_id_fulfilled_by_fkey"
  FOREIGN KEY ("tenant_id", "fulfilled_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "purchase_requests" ADD CONSTRAINT "purchase_requests_text_length"
  CHECK ("number" > 0
     AND char_length("title") BETWEEN 3 AND 200
     AND ("description" IS NULL OR char_length("description") BETWEEN 1 AND 2000)
     AND ("decision_note" IS NULL OR char_length("decision_note") BETWEEN 1 AND 1000)
     AND ("fulfilled_reference" IS NULL OR char_length("fulfilled_reference") BETWEEN 1 AND 120));
ALTER TABLE "purchase_requests" ADD CONSTRAINT "purchase_requests_amounts"
  CHECK ("estimated_amount" > 0 AND "estimated_amount" < 1000000000000
     AND ("quantity" IS NULL OR ("quantity" > 0 AND "quantity" < 1000000))
     AND (("stock_item_id" IS NULL) = ("quantity" IS NULL)));
-- Each state with what made it, and nothing of a state it never reached.
ALTER TABLE "purchase_requests" ADD CONSTRAINT "purchase_requests_state_shape"
  CHECK ("status" IN ('requested', 'approved', 'rejected', 'cancelled', 'fulfilled')
     AND (("decided_at" IS NULL) = ("decided_by_account_id" IS NULL))
     AND ("status" NOT IN ('approved', 'rejected', 'fulfilled') OR "decided_at" IS NOT NULL)
     AND ("status" <> 'requested' OR "decided_at" IS NULL)
     AND (("status" = 'rejected') = ("reject_reason" IS NOT NULL))
     AND ("reject_reason" IS NULL
          OR "reject_reason" IN ('no_budget', 'not_needed', 'use_stock', 'too_costly', 'other'))
     AND ("approval_request_id" IS NULL OR "status" IN ('approved', 'fulfilled', 'cancelled'))
     AND (("status" = 'cancelled') = ("cancelled_at" IS NOT NULL))
     AND (("cancelled_at" IS NULL) = ("cancelled_by_account_id" IS NULL))
     AND (("cancelled_at" IS NULL) = ("cancel_reason" IS NULL))
     AND ("cancel_reason" IS NULL
          OR "cancel_reason" IN ('not_needed', 'duplicate', 'vendor_unavailable', 'other'))
     AND (("status" = 'fulfilled') = ("fulfilled_at" IS NOT NULL))
     AND (("fulfilled_at" IS NULL) = ("fulfilled_by_account_id" IS NULL))
     AND ("fulfilled_reference" IS NULL OR "fulfilled_at" IS NOT NULL));

-- Forward only: requested → approved | rejected | cancelled; approved →
-- fulfilled | cancelled. What was asked never changes; a decision once.
CREATE FUNCTION purchase_requests_move_forward() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."number" = OLD."number" AND NEW."title" = OLD."title"
     AND NEW."description" IS NOT DISTINCT FROM OLD."description"
     AND NEW."vendor_id" IS NOT DISTINCT FROM OLD."vendor_id"
     AND NEW."budget_line_id" IS NOT DISTINCT FROM OLD."budget_line_id"
     AND NEW."stock_item_id" IS NOT DISTINCT FROM OLD."stock_item_id"
     AND NEW."quantity" IS NOT DISTINCT FROM OLD."quantity"
     AND NEW."estimated_amount" = OLD."estimated_amount"
     AND NEW."needed_by" IS NOT DISTINCT FROM OLD."needed_by"
     AND NEW."requested_by_account_id" = OLD."requested_by_account_id"
     AND NEW."requested_at" = OLD."requested_at"
     AND NEW."created_at" = OLD."created_at"
     AND ((OLD."status" = 'requested' AND NEW."status" IN ('approved', 'rejected', 'cancelled'))
       OR (OLD."status" = 'approved' AND NEW."status" IN ('fulfilled', 'cancelled')
           AND NEW."decided_at" = OLD."decided_at"
           AND NEW."decided_by_account_id" = OLD."decided_by_account_id"
           AND NEW."decision_note" IS NOT DISTINCT FROM OLD."decision_note"
           AND NEW."approval_request_id" IS NOT DISTINCT FROM OLD."approval_request_id")) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'purchase_requests: a request moves forward only (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER purchase_requests_move_forward
  BEFORE UPDATE OR DELETE ON "purchase_requests"
  FOR EACH ROW EXECUTE FUNCTION purchase_requests_move_forward();
CREATE TRIGGER purchase_requests_move_forward_truncate
  BEFORE TRUNCATE ON "purchase_requests"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "purchase_requests" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "purchase_requests" TO jiwar_app;
ALTER TABLE "purchase_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "purchase_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "purchase_requests"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- The staff inbox (ADR 0073) gathers a purchase request waiting for its
-- approver: both type CHECKs are recreated with it. No row changes.
ALTER TABLE "staff_inbox_due_hours" DROP CONSTRAINT "staff_inbox_due_hours_type";
ALTER TABLE "staff_inbox_due_hours" ADD CONSTRAINT "staff_inbox_due_hours_type"
  CHECK ("type" IN ('registration', 'identity_change', 'worker_engagement', 'vehicle',
    'booking', 'unit_permit', 'work_permit', 'field_exception', 'plan_request',
    'invoice_dispute', 'decision_appeal', 'management_request', 'purchase_request'));
ALTER TABLE "staff_inbox_overdue" DROP CONSTRAINT "staff_inbox_overdue_type";
ALTER TABLE "staff_inbox_overdue" ADD CONSTRAINT "staff_inbox_overdue_type"
  CHECK ("type" IN ('registration', 'identity_change', 'worker_engagement', 'vehicle',
    'booking', 'unit_permit', 'work_permit', 'field_exception', 'plan_request',
    'invoice_dispute', 'decision_appeal', 'management_request', 'purchase_request'));
