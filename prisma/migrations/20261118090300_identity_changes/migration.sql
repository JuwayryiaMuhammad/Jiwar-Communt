-- ============================================================================
-- A name or phone change an account asks for itself (ADR 0062)
-- ============================================================================
--
-- The name is the ID document's and the guard checks it; the phone is a
-- login identifier and no SMS channel proves it. So neither is changed by
-- the account itself: it asks, and a manager (`residents.manage`) approves
-- or rejects. One pending request per account. The new value lives only
-- while the request is pending: the decision or a cancellation erases it.
-- A request moves once, forward; nothing else about it ever changes.

CREATE TABLE "account_identity_changes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "field" TEXT NOT NULL,
    "new_value" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "decided_at" TIMESTAMPTZ(3),
    "decided_by" UUID,
    "reason_code" TEXT,
    CONSTRAINT "account_identity_changes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "account_identity_changes_tenant_id_id_key"
  ON "account_identity_changes"("tenant_id", "id");
CREATE UNIQUE INDEX "account_identity_changes_one_pending"
  ON "account_identity_changes"("tenant_id", "account_id") WHERE "status" = 'pending';
CREATE INDEX "account_identity_changes_queue_idx"
  ON "account_identity_changes"("tenant_id", "status", "created_at");
CREATE INDEX "account_identity_changes_account_idx"
  ON "account_identity_changes"("tenant_id", "account_id", "created_at" DESC);
ALTER TABLE "account_identity_changes"
  ADD CONSTRAINT "account_identity_changes_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "account_identity_changes_account_fkey"
  FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "account_identity_changes_decided_by_fkey"
  FOREIGN KEY ("tenant_id", "decided_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "account_identity_changes" ADD CONSTRAINT "account_identity_changes_field"
  CHECK ("field" IN ('name', 'phone'));
ALTER TABLE "account_identity_changes" ADD CONSTRAINT "account_identity_changes_status"
  CHECK ("status" IN ('pending', 'approved', 'rejected', 'cancelled'));
-- The value exactly while pending; a name is 2 to 200 characters, a phone
-- is stored in E.164.
ALTER TABLE "account_identity_changes" ADD CONSTRAINT "account_identity_changes_value_while_pending"
  CHECK (("status" = 'pending') = ("new_value" IS NOT NULL));
ALTER TABLE "account_identity_changes" ADD CONSTRAINT "account_identity_changes_value_shape"
  CHECK ("new_value" IS NULL
      OR ("field" = 'name' AND char_length("new_value") BETWEEN 2 AND 200)
      OR ("field" = 'phone' AND "new_value" ~ '^\+[1-9][0-9]{6,14}$'));
ALTER TABLE "account_identity_changes" ADD CONSTRAINT "account_identity_changes_decided_shape"
  CHECK (("status" = 'pending') = ("decided_at" IS NULL)
     AND ("decided_by" IS NOT NULL) = ("status" IN ('approved', 'rejected'))
     AND ("reason_code" IS NOT NULL) = ("status" = 'rejected'));
ALTER TABLE "account_identity_changes" ADD CONSTRAINT "account_identity_changes_reason_code"
  CHECK ("reason_code" IS NULL
      OR "reason_code" IN ('not_verified', 'does_not_match_documents', 'other'));
ALTER TABLE "account_identity_changes" ADD CONSTRAINT "account_identity_changes_decided_after"
  CHECK ("decided_at" IS NULL OR "decided_at" >= "created_at");

-- Once, forward: pending to a decision or a cancellation, the value erased
-- with it; the request's identity never changes.
CREATE FUNCTION account_identity_change_moves_once() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD."status" = 'pending' AND NEW."status" <> 'pending'
     AND NEW."new_value" IS NULL
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."account_id" = OLD."account_id"
     AND NEW."field" = OLD."field"
     AND NEW."created_at" = OLD."created_at" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'account_identity_changes: a request is decided or cancelled once and otherwise never changes (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER account_identity_changes_moves_once
  BEFORE UPDATE OR DELETE ON "account_identity_changes"
  FOR EACH ROW EXECUTE FUNCTION account_identity_change_moves_once();
CREATE TRIGGER account_identity_changes_no_truncate
  BEFORE TRUNCATE ON "account_identity_changes"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- Locked FOR UPDATE by the decision and the cancellation: UPDATE, which the
-- trigger limits to that one move.
REVOKE ALL ON "account_identity_changes" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "account_identity_changes" TO jiwar_app;
ALTER TABLE "account_identity_changes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "account_identity_changes" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "account_identity_changes"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
