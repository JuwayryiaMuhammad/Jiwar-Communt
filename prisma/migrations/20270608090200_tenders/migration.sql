-- ============================================================================
-- Tenders (ADR 0088): a request for bids with its documents, the vendors
-- invited to it — a registered vendor (its contractors bid), or one that is
-- not registered, through a time-limited bid link of this tender alone —
-- sealed bids, an opening by two different people, and an award that signs
-- the compound's contract (ADR 0077) with the winning vendor.
--
-- - A TN- number a compound (procurement_counters).
-- - A tender moves forward only: draft → open (published, taking bids
--   until its deadline) → opening (a first holder of tenders.open began
--   it, after the deadline) → opened (a second, different person confirmed
--   it; the bids are unsealed) → awarded; any of them but awarded →
--   cancelled. Its terms are fixed once published; the deadline may only
--   move later, and only before it passes.
-- - A bid's amount is sealed by the database: it is written into
--   `sealed_amount`, which the app's role may insert but never read; the
--   plain `amount` is NULL until the tender is opened, when a trigger copies
--   it, and only then. Nobody — the manager included — reads an amount
--   before the opening. A bid is never edited: it is withdrawn while the
--   tender takes bids, and another sent.
-- - A bid link is global (no compound is known before it is opened), like
--   ADR 0060's desk links: SHA-256 of a 32-byte token with a label, one live
--   link an invitation, revoked once, expiring at the tender's deadline at
--   the latest.
-- ============================================================================

ALTER TABLE "procurement_counters" DROP CONSTRAINT "procurement_counters_kind_known";
ALTER TABLE "procurement_counters" ADD CONSTRAINT "procurement_counters_kind_known"
  CHECK ("kind" IN ('vendor', 'purchase_request', 'tender'));

-- ----------------------------------------------------------------------------
-- Tenders.
-- ----------------------------------------------------------------------------
CREATE TABLE "tenders" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "scope" TEXT,
    "category" TEXT NOT NULL,
    "contract_kind" TEXT NOT NULL,
    "budget_line_id" UUID,
    "estimated_value" DECIMAL(14,2),
    "bids_due_at" TIMESTAMPTZ(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "created_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "published_by_account_id" UUID,
    "published_at" TIMESTAMPTZ(3),
    "opening_started_by_account_id" UUID,
    "opening_started_at" TIMESTAMPTZ(3),
    "opened_by_account_id" UUID,
    "opened_at" TIMESTAMPTZ(3),
    "bid_count" INTEGER,
    "awarded_bid_id" UUID,
    "awarded_by_account_id" UUID,
    "awarded_at" TIMESTAMPTZ(3),
    "contract_id" UUID,
    "cancelled_by_account_id" UUID,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" TEXT,
    CONSTRAINT "tenders_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "tenders_tenant_id_id_key" ON "tenders"("tenant_id", "id");
CREATE UNIQUE INDEX "tenders_number_key" ON "tenders"("tenant_id", "number");
-- A contract signs one tender's award.
CREATE UNIQUE INDEX "tenders_contract_key"
  ON "tenders"("tenant_id", "contract_id") WHERE "contract_id" IS NOT NULL;
CREATE INDEX "tenders_status_idx" ON "tenders"("tenant_id", "status", "bids_due_at", "id");
ALTER TABLE "tenders"
  ADD CONSTRAINT "tenders_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "tenders_budget_line_fkey"
  FOREIGN KEY ("tenant_id", "budget_line_id") REFERENCES "finance_budget_lines"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "tenders_contract_fkey"
  FOREIGN KEY ("tenant_id", "contract_id") REFERENCES "maintenance_contracts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "tenders_created_by_fkey"
  FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "tenders_published_by_fkey"
  FOREIGN KEY ("tenant_id", "published_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "tenders_opening_started_by_fkey"
  FOREIGN KEY ("tenant_id", "opening_started_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "tenders_opened_by_fkey"
  FOREIGN KEY ("tenant_id", "opened_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "tenders_awarded_by_fkey"
  FOREIGN KEY ("tenant_id", "awarded_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "tenders_cancelled_by_fkey"
  FOREIGN KEY ("tenant_id", "cancelled_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- VENDOR_CATEGORIES (ADR 0077) and CONTRACT_KINDS (ADR 0065, 0077); unit
-- tests keep them in step.
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_shape"
  CHECK ("number" > 0
     AND char_length("title") BETWEEN 3 AND 200
     AND ("scope" IS NULL OR char_length("scope") BETWEEN 1 AND 4000)
     AND "category" IN ('maintenance', 'cleaning', 'security', 'landscaping', 'pest_control',
                        'supplies', 'utilities', 'professional', 'other')
     AND "contract_kind" IN ('amc', 'service', 'warranty_extension', 'cleaning', 'security',
                             'landscaping', 'pest_control', 'supply', 'other')
     AND ("estimated_value" IS NULL OR "estimated_value" BETWEEN 0.01 AND 999999999.99)
     AND "bids_due_at" > "created_at");
-- Each state with who made it. The opening is two different people: a
-- CHECK, not only the service. REASON_CODES.tenderCancel; a unit test keeps
-- it in step.
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_state_shape"
  CHECK ("status" IN ('draft', 'open', 'opening', 'opened', 'awarded', 'cancelled')
     AND (("published_at" IS NULL) = ("published_by_account_id" IS NULL))
     AND (("status" = 'draft') = ("published_at" IS NULL) OR "status" = 'cancelled')
     AND (("opening_started_at" IS NULL) = ("opening_started_by_account_id" IS NULL))
     AND ("status" NOT IN ('opening', 'opened', 'awarded') OR "opening_started_at" IS NOT NULL)
     AND ("opening_started_at" IS NULL OR "opening_started_at" >= "bids_due_at")
     AND (("opened_at" IS NULL) = ("opened_by_account_id" IS NULL))
     AND (("opened_at" IS NULL) = ("bid_count" IS NULL))
     AND (("status" IN ('opened', 'awarded')) = ("opened_at" IS NOT NULL) OR "status" = 'cancelled')
     AND ("opened_by_account_id" IS NULL OR "opened_by_account_id" <> "opening_started_by_account_id")
     AND ("bid_count" IS NULL OR "bid_count" >= 0)
     AND (("status" = 'awarded') = ("awarded_at" IS NOT NULL))
     AND (("awarded_at" IS NULL) = ("awarded_by_account_id" IS NULL))
     AND (("awarded_at" IS NULL) = ("awarded_bid_id" IS NULL))
     AND (("awarded_at" IS NULL) = ("contract_id" IS NULL))
     AND (("status" = 'cancelled') = ("cancelled_at" IS NOT NULL))
     AND (("cancelled_at" IS NULL) = ("cancelled_by_account_id" IS NULL))
     AND (("cancelled_at" IS NULL) = ("cancel_reason" IS NULL))
     AND ("cancel_reason" IS NULL
          OR "cancel_reason" IN ('not_needed', 'no_bids', 'over_budget', 'rescoped', 'other')));

-- A draft's terms change; once published they are fixed, but for a later
-- deadline before the first passes. Forward only.
CREATE FUNCTION tenders_move_forward() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."number" = OLD."number"
     AND NEW."created_by_account_id" = OLD."created_by_account_id"
     AND NEW."created_at" = OLD."created_at"
     AND (OLD."status" = 'draft'
          OR (NEW."title" = OLD."title"
              AND NEW."scope" IS NOT DISTINCT FROM OLD."scope"
              AND NEW."category" = OLD."category"
              AND NEW."contract_kind" = OLD."contract_kind"
              AND NEW."budget_line_id" IS NOT DISTINCT FROM OLD."budget_line_id"
              AND NEW."estimated_value" IS NOT DISTINCT FROM OLD."estimated_value"
              AND (NEW."bids_due_at" = OLD."bids_due_at"
                   OR (OLD."status" = 'open' AND NEW."status" = 'open'
                       AND NEW."bids_due_at" > OLD."bids_due_at"
                       AND OLD."bids_due_at" > clock_timestamp()))))
     AND (NEW."status" = OLD."status"
          OR (OLD."status" = 'draft' AND NEW."status" IN ('open', 'cancelled'))
          OR (OLD."status" = 'open' AND NEW."status" IN ('opening', 'cancelled'))
          OR (OLD."status" = 'opening' AND NEW."status" IN ('opened', 'cancelled'))
          OR (OLD."status" = 'opened' AND NEW."status" IN ('awarded', 'cancelled')))
     AND OLD."status" NOT IN ('awarded', 'cancelled')
     AND (OLD."published_at" IS NULL
          OR (NEW."published_at" = OLD."published_at"
              AND NEW."published_by_account_id" = OLD."published_by_account_id"))
     AND (OLD."opening_started_at" IS NULL
          OR (NEW."opening_started_at" = OLD."opening_started_at"
              AND NEW."opening_started_by_account_id" = OLD."opening_started_by_account_id"))
     AND (OLD."opened_at" IS NULL
          OR (NEW."opened_at" = OLD."opened_at"
              AND NEW."opened_by_account_id" = OLD."opened_by_account_id"
              AND NEW."bid_count" = OLD."bid_count")) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'tenders: a tender keeps its terms once published and moves forward only (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER tenders_move_forward
  BEFORE UPDATE OR DELETE ON "tenders"
  FOR EACH ROW EXECUTE FUNCTION tenders_move_forward();
CREATE TRIGGER tenders_truncate
  BEFORE TRUNCATE ON "tenders"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- A tender's documents: removed once, never edited.
-- ----------------------------------------------------------------------------
CREATE TABLE "tender_documents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "tender_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "added_by_account_id" UUID NOT NULL,
    "added_at" TIMESTAMPTZ(3) NOT NULL,
    "removed_by_account_id" UUID,
    "removed_at" TIMESTAMPTZ(3),
    CONSTRAINT "tender_documents_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "tender_documents_file_key" ON "tender_documents"("tenant_id", "file_id");
CREATE INDEX "tender_documents_tender_idx"
  ON "tender_documents"("tenant_id", "tender_id", "added_at", "id");
ALTER TABLE "tender_documents"
  ADD CONSTRAINT "tender_documents_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "tender_documents_tender_fkey"
  FOREIGN KEY ("tenant_id", "tender_id") REFERENCES "tenders"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "tender_documents_file_fkey"
  FOREIGN KEY ("tenant_id", "file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "tender_documents_added_by_fkey"
  FOREIGN KEY ("tenant_id", "added_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "tender_documents_removed_by_fkey"
  FOREIGN KEY ("tenant_id", "removed_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "tender_documents" ADD CONSTRAINT "tender_documents_shape"
  CHECK (char_length("title") BETWEEN 1 AND 120
     AND (("removed_at" IS NULL) = ("removed_by_account_id" IS NULL)));

CREATE FUNCTION tender_documents_kept() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."tender_id" = OLD."tender_id" AND NEW."file_id" = OLD."file_id"
     AND NEW."title" = OLD."title"
     AND NEW."added_by_account_id" = OLD."added_by_account_id"
     AND NEW."added_at" = OLD."added_at"
     AND OLD."removed_at" IS NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'tender_documents: a document is removed once and otherwise never changes (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER tender_documents_kept
  BEFORE UPDATE OR DELETE ON "tender_documents"
  FOR EACH ROW EXECUTE FUNCTION tender_documents_kept();
CREATE TRIGGER tender_documents_truncate
  BEFORE TRUNCATE ON "tender_documents"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Invitations: a registered vendor, or a company with a bid link.
-- ----------------------------------------------------------------------------
CREATE TABLE "tender_invitations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "tender_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "vendor_id" UUID,
    "company_name" TEXT,
    "contact_email" TEXT,
    "invited_by_account_id" UUID NOT NULL,
    "invited_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_by_account_id" UUID,
    "revoked_at" TIMESTAMPTZ(3),
    CONSTRAINT "tender_invitations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "tender_invitations_tenant_id_id_key" ON "tender_invitations"("tenant_id", "id");
-- A registered vendor once among a tender's live invitations.
CREATE UNIQUE INDEX "tender_invitations_one_live_vendor"
  ON "tender_invitations"("tenant_id", "tender_id", "vendor_id")
  WHERE "vendor_id" IS NOT NULL AND "revoked_at" IS NULL;
CREATE INDEX "tender_invitations_tender_idx"
  ON "tender_invitations"("tenant_id", "tender_id", "invited_at", "id");
CREATE INDEX "tender_invitations_vendor_idx"
  ON "tender_invitations"("tenant_id", "vendor_id", "invited_at" DESC) WHERE "vendor_id" IS NOT NULL;
ALTER TABLE "tender_invitations"
  ADD CONSTRAINT "tender_invitations_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "tender_invitations_tender_fkey"
  FOREIGN KEY ("tenant_id", "tender_id") REFERENCES "tenders"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "tender_invitations_vendor_fkey"
  FOREIGN KEY ("tenant_id", "vendor_id") REFERENCES "vendors"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "tender_invitations_invited_by_fkey"
  FOREIGN KEY ("tenant_id", "invited_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "tender_invitations_revoked_by_fkey"
  FOREIGN KEY ("tenant_id", "revoked_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "tender_invitations" ADD CONSTRAINT "tender_invitations_shape"
  CHECK ("kind" IN ('vendor', 'link')
     AND (("kind" = 'vendor') = ("vendor_id" IS NOT NULL))
     AND (("kind" = 'link') = ("company_name" IS NOT NULL))
     AND ("company_name" IS NULL OR char_length("company_name") BETWEEN 2 AND 200)
     AND ("contact_email" IS NULL OR ("kind" = 'link' AND char_length("contact_email") BETWEEN 3 AND 254))
     AND (("revoked_at" IS NULL) = ("revoked_by_account_id" IS NULL)));

CREATE FUNCTION tender_invitations_kept() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."tender_id" = OLD."tender_id" AND NEW."kind" = OLD."kind"
     AND NEW."vendor_id" IS NOT DISTINCT FROM OLD."vendor_id"
     AND NEW."company_name" IS NOT DISTINCT FROM OLD."company_name"
     AND NEW."contact_email" IS NOT DISTINCT FROM OLD."contact_email"
     AND NEW."invited_by_account_id" = OLD."invited_by_account_id"
     AND NEW."invited_at" = OLD."invited_at"
     AND OLD."revoked_at" IS NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'tender_invitations: an invitation is revoked once and otherwise never changes (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER tender_invitations_kept
  BEFORE UPDATE OR DELETE ON "tender_invitations"
  FOR EACH ROW EXECUTE FUNCTION tender_invitations_kept();
CREATE TRIGGER tender_invitations_truncate
  BEFORE TRUNCATE ON "tender_invitations"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Bids, sealed.
-- ----------------------------------------------------------------------------
CREATE TABLE "tender_bids" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "tender_id" UUID NOT NULL,
    "invitation_id" UUID NOT NULL,
    "submitted_by_account_id" UUID,
    "submitted_at" TIMESTAMPTZ(3) NOT NULL,
    "sealed_amount" DECIMAL(14,2) NOT NULL,
    "amount" DECIMAL(14,2),
    "unsealed_at" TIMESTAMPTZ(3),
    "duration_days" INTEGER,
    "note" TEXT,
    "file_id" UUID,
    "withdrawn_at" TIMESTAMPTZ(3),
    "vendor_id" UUID,
    CONSTRAINT "tender_bids_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "tender_bids_tenant_id_id_key" ON "tender_bids"("tenant_id", "id");
-- One live bid an invitation.
CREATE UNIQUE INDEX "tender_bids_one_live"
  ON "tender_bids"("tenant_id", "invitation_id") WHERE "withdrawn_at" IS NULL;
CREATE UNIQUE INDEX "tender_bids_file_key"
  ON "tender_bids"("tenant_id", "file_id") WHERE "file_id" IS NOT NULL;
CREATE INDEX "tender_bids_tender_idx" ON "tender_bids"("tenant_id", "tender_id", "submitted_at", "id");
ALTER TABLE "tender_bids"
  ADD CONSTRAINT "tender_bids_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "tender_bids_tender_fkey"
  FOREIGN KEY ("tenant_id", "tender_id") REFERENCES "tenders"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "tender_bids_invitation_fkey"
  FOREIGN KEY ("tenant_id", "invitation_id") REFERENCES "tender_invitations"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "tender_bids_submitted_by_fkey"
  FOREIGN KEY ("tenant_id", "submitted_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "tender_bids_file_fkey"
  FOREIGN KEY ("tenant_id", "file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "tender_bids_vendor_fkey"
  FOREIGN KEY ("tenant_id", "vendor_id") REFERENCES "vendors"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_awarded_bid_fkey"
  FOREIGN KEY ("tenant_id", "awarded_bid_id") REFERENCES "tender_bids"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "tender_bids" ADD CONSTRAINT "tender_bids_shape"
  CHECK ("sealed_amount" BETWEEN 0.01 AND 999999999.99
     AND ("amount" IS NULL OR "amount" = "sealed_amount")
     AND (("amount" IS NULL) = ("unsealed_at" IS NULL))
     AND ("duration_days" IS NULL OR "duration_days" BETWEEN 1 AND 3650)
     AND ("note" IS NULL OR char_length("note") BETWEEN 1 AND 2000)
     AND ("withdrawn_at" IS NULL OR "unsealed_at" IS NULL));

-- The seal. An amount is never written plain: it is copied from the seal
-- when, and only when, the bid's tender is opened. A bid's terms never
-- change; it is withdrawn once while its tender takes bids; a link
-- bidder's vendor is named once, at the award.
CREATE FUNCTION tender_bids_sealed() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  st text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."amount" IS NOT NULL OR NEW."unsealed_at" IS NOT NULL OR NEW."withdrawn_at" IS NOT NULL THEN
      RAISE EXCEPTION 'tender_bids: a bid comes in sealed'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."tender_id" = OLD."tender_id" AND NEW."invitation_id" = OLD."invitation_id"
     AND NEW."submitted_by_account_id" IS NOT DISTINCT FROM OLD."submitted_by_account_id"
     AND NEW."submitted_at" = OLD."submitted_at"
     AND NEW."sealed_amount" = OLD."sealed_amount"
     AND NEW."duration_days" IS NOT DISTINCT FROM OLD."duration_days"
     AND NEW."note" IS NOT DISTINCT FROM OLD."note"
     AND NEW."file_id" IS NOT DISTINCT FROM OLD."file_id"
     AND (OLD."vendor_id" IS NULL OR NEW."vendor_id" IS NOT DISTINCT FROM OLD."vendor_id") THEN
    SELECT "status" INTO st FROM "tenders" WHERE "id" = NEW."tender_id";
    IF NEW."unsealed_at" IS DISTINCT FROM OLD."unsealed_at" THEN
      IF OLD."unsealed_at" IS NOT NULL OR OLD."withdrawn_at" IS NOT NULL OR st <> 'opened' THEN
        RAISE EXCEPTION 'tender_bids: a bid is unsealed once, by its tender''s opening'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
      NEW."amount" := OLD."sealed_amount";
    ELSIF NEW."amount" IS DISTINCT FROM OLD."amount" THEN
      RAISE EXCEPTION 'tender_bids: an amount is never written plain'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW."withdrawn_at" IS DISTINCT FROM OLD."withdrawn_at"
       AND (OLD."withdrawn_at" IS NOT NULL OR st <> 'open') THEN
      RAISE EXCEPTION 'tender_bids: a bid is withdrawn once, while its tender takes bids'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'tender_bids: a bid keeps its terms (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER tender_bids_sealed
  BEFORE INSERT OR UPDATE OR DELETE ON "tender_bids"
  FOR EACH ROW EXECUTE FUNCTION tender_bids_sealed();
CREATE TRIGGER tender_bids_truncate
  BEFORE TRUNCATE ON "tender_bids"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Bid links: global, like the desk links (ADR 0060).
-- ----------------------------------------------------------------------------
CREATE TABLE "tender_bid_links" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "tender_id" UUID NOT NULL,
    "invitation_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "created_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_by_account_id" UUID,
    CONSTRAINT "tender_bid_links_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "tender_bid_links_token_hash_key" ON "tender_bid_links"("token_hash");
CREATE UNIQUE INDEX "tender_bid_links_one_live"
  ON "tender_bid_links"("tenant_id", "invitation_id") WHERE "revoked_at" IS NULL;
CREATE INDEX "tender_bid_links_invitation_idx"
  ON "tender_bid_links"("tenant_id", "invitation_id", "created_at" DESC);
ALTER TABLE "tender_bid_links"
  ADD CONSTRAINT "tender_bid_links_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "tender_bid_links_tender_fkey"
  FOREIGN KEY ("tenant_id", "tender_id") REFERENCES "tenders"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "tender_bid_links_invitation_fkey"
  FOREIGN KEY ("tenant_id", "invitation_id") REFERENCES "tender_invitations"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "tender_bid_links_created_by_fkey"
  FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "tender_bid_links_revoked_by_fkey"
  FOREIGN KEY ("tenant_id", "revoked_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "tender_bid_links" ADD CONSTRAINT "tender_bid_links_token_hash_hex"
  CHECK ("token_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "tender_bid_links" ADD CONSTRAINT "tender_bid_links_validity"
  CHECK ("expires_at" > "created_at");
ALTER TABLE "tender_bid_links" ADD CONSTRAINT "tender_bid_links_revoked_shape"
  CHECK (("revoked_at" IS NULL) = ("revoked_by_account_id" IS NULL));

CREATE FUNCTION tender_bid_link_is_kept() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."tender_id" = OLD."tender_id"
     AND NEW."invitation_id" = OLD."invitation_id"
     AND NEW."token_hash" = OLD."token_hash"
     AND NEW."created_by_account_id" = OLD."created_by_account_id"
     AND NEW."created_at" = OLD."created_at"
     AND NEW."expires_at" = OLD."expires_at"
     AND OLD."revoked_at" IS NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'tender_bid_links: a bid link is revoked once and otherwise never changes (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER tender_bid_links_kept
  BEFORE UPDATE OR DELETE ON "tender_bid_links"
  FOR EACH ROW EXECUTE FUNCTION tender_bid_link_is_kept();
CREATE TRIGGER tender_bid_links_kept_truncate
  BEFORE TRUNCATE ON "tender_bid_links"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Privileges and RLS. A tender's and an invitation's row is locked FOR
-- UPDATE, which needs UPDATE; documents are removed once. A bid's seal is
-- the app's to write and never to read: its role selects every column but
-- `sealed_amount`, and updates only what moves (the withdrawal, the
-- unsealing, a link bidder's vendor). The bid links are global: no RLS,
-- reached only through GlobalDbService.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "tenders", "tender_documents", "tender_invitations", "tender_bids",
  "tender_bid_links" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "tenders", "tender_documents", "tender_invitations",
  "tender_bid_links" TO jiwar_app;
GRANT INSERT ON "tender_bids" TO jiwar_app;
GRANT SELECT ("id", "tenant_id", "tender_id", "invitation_id", "submitted_by_account_id",
  "submitted_at", "amount", "unsealed_at", "duration_days", "note", "file_id",
  "withdrawn_at", "vendor_id") ON "tender_bids" TO jiwar_app;
GRANT UPDATE ("withdrawn_at", "unsealed_at", "amount", "vendor_id") ON "tender_bids" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenders', 'tender_documents', 'tender_invitations', 'tender_bids'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
