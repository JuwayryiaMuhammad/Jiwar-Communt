-- ============================================================================
-- The field team, part b (ADR 0090): dangling accounts and access reviews.
-- ============================================================================
--
-- Of the compound's side only: staff, manager and contractor accounts.
--
-- * `account_check_settings`: how many days without a sign-in make an
--   account idle (60, 14 to 365) and every how many days an access review
--   opens (90, 30 to 365). One row a compound, made by its first change;
--   with none the defaults hold.
-- * `dangling_account_findings`: an active account that looks dangling —
--   idle, never signed into within 14 days of its creation, or a contractor
--   whose vendor is suspended. One open per account (a partial unique index
--   behind the account's lock). Kept once with a code (muted 90 days),
--   deactivated once, or cleared by the system when it no longer holds or
--   the account left. Ids and codes only.
-- * `access_reviews`, `access_review_lines`: a review of who has access,
--   one open per compound, a frozen snapshot of every active account of the
--   compound's side when it opened: its kind, its role and the role's
--   permissions then, its last sign-in. Each line is kept or revoked once
--   (revoked deactivates the account in the same transaction), or marked
--   `left` by the system when the account left first. The review closes
--   once every line is decided.

CREATE TABLE "account_check_settings" (
    "tenant_id" UUID NOT NULL,
    "idle_days" SMALLINT NOT NULL DEFAULT 60,
    "review_every_days" SMALLINT NOT NULL DEFAULT 90,
    "updated_by_account_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_check_settings_pkey" PRIMARY KEY ("tenant_id")
);
ALTER TABLE "account_check_settings"
  ADD CONSTRAINT "account_check_settings_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "account_check_settings_updated_by_fkey"
    FOREIGN KEY ("tenant_id", "updated_by_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "account_check_settings_ranges"
    CHECK ("idle_days" BETWEEN 14 AND 365 AND "review_every_days" BETWEEN 30 AND 365);

REVOKE ALL ON "account_check_settings" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "account_check_settings" TO jiwar_app;

ALTER TABLE "account_check_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "account_check_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "account_check_settings"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ----------------------------------------------------------------------------

CREATE TABLE "dangling_account_findings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "last_active_at" TIMESTAMPTZ(3),
    "found_at" TIMESTAMPTZ(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "decided_at" TIMESTAMPTZ(3),
    "decided_by_account_id" UUID,
    "reason_code" TEXT,
    "muted_until" TIMESTAMPTZ(3),
    "cleared_at" TIMESTAMPTZ(3),

    CONSTRAINT "dangling_account_findings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "dangling_account_findings_tenant_id_id_key"
  ON "dangling_account_findings" ("tenant_id", "id");
-- One open finding per account.
CREATE UNIQUE INDEX "dangling_account_findings_one_open_key"
  ON "dangling_account_findings" ("tenant_id", "account_id")
  WHERE "status" = 'open';
CREATE INDEX "dangling_account_findings_status_idx"
  ON "dangling_account_findings" ("tenant_id", "status", "found_at", "id");
CREATE INDEX "dangling_account_findings_account_idx"
  ON "dangling_account_findings" ("tenant_id", "account_id", "found_at" DESC);

ALTER TABLE "dangling_account_findings"
  ADD CONSTRAINT "dangling_account_findings_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "dangling_account_findings_account_fkey"
    FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "dangling_account_findings_decided_by_fkey"
    FOREIGN KEY ("tenant_id", "decided_by_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "dangling_account_findings_reason"
    CHECK ("reason" IN ('idle', 'vendor_suspended', 'never_signed_in')),
  -- Each status carries exactly its facts; a keep names a code of
  -- REASON_CODES.danglingKeep (a unit test keeps them in step).
  ADD CONSTRAINT "dangling_account_findings_status_shape"
    CHECK (("status" = 'open'
            AND "decided_at" IS NULL AND "decided_by_account_id" IS NULL
            AND "reason_code" IS NULL AND "muted_until" IS NULL AND "cleared_at" IS NULL)
        OR ("status" = 'kept'
            AND "decided_at" IS NOT NULL AND "decided_by_account_id" IS NOT NULL
            AND "reason_code" IS NOT NULL AND "reason_code" IN ('on_leave', 'seasonal_work', 'rarely_needed', 'other')
            AND "muted_until" IS NOT NULL AND "muted_until" > "decided_at"
            AND "cleared_at" IS NULL)
        OR ("status" = 'deactivated'
            AND "decided_at" IS NOT NULL AND "decided_by_account_id" IS NOT NULL
            AND "reason_code" IS NULL AND "muted_until" IS NULL AND "cleared_at" IS NULL)
        OR ("status" = 'cleared'
            AND "decided_at" IS NULL AND "decided_by_account_id" IS NULL
            AND "reason_code" IS NULL AND "muted_until" IS NULL AND "cleared_at" IS NOT NULL));

-- A finding keeps what was found; it leaves `open` once, and never goes.
CREATE FUNCTION dangling_account_finding_decided_once() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."account_id" = OLD."account_id"
     AND NEW."reason" = OLD."reason"
     AND NEW."last_active_at" IS NOT DISTINCT FROM OLD."last_active_at"
     AND NEW."found_at" = OLD."found_at"
     AND OLD."status" = 'open' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'dangling_account_findings: a finding is decided once and never deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER dangling_account_findings_decided_once
  BEFORE UPDATE OR DELETE ON "dangling_account_findings"
  FOR EACH ROW EXECUTE FUNCTION dangling_account_finding_decided_once();
CREATE TRIGGER dangling_account_findings_decided_once_truncate
  BEFORE TRUNCATE ON "dangling_account_findings"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "dangling_account_findings" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "dangling_account_findings" TO jiwar_app;

ALTER TABLE "dangling_account_findings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dangling_account_findings" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "dangling_account_findings"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ----------------------------------------------------------------------------

CREATE TABLE "access_reviews" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "opened_at" TIMESTAMPTZ(3) NOT NULL,
    "opened_by_account_id" UUID,
    "lines" INTEGER NOT NULL,
    "kept" INTEGER NOT NULL DEFAULT 0,
    "revoked" INTEGER NOT NULL DEFAULT 0,
    "left_count" INTEGER NOT NULL DEFAULT 0,
    "closed_at" TIMESTAMPTZ(3),

    CONSTRAINT "access_reviews_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "access_reviews_tenant_id_id_key"
  ON "access_reviews" ("tenant_id", "id");
CREATE UNIQUE INDEX "access_reviews_number_key"
  ON "access_reviews" ("tenant_id", "number");
-- One open review per compound.
CREATE UNIQUE INDEX "access_reviews_one_open_key"
  ON "access_reviews" ("tenant_id")
  WHERE "status" = 'open';
CREATE INDEX "access_reviews_opened_idx"
  ON "access_reviews" ("tenant_id", "opened_at" DESC, "id" DESC);

ALTER TABLE "access_reviews"
  ADD CONSTRAINT "access_reviews_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "access_reviews_opened_by_fkey"
    FOREIGN KEY ("tenant_id", "opened_by_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "access_reviews_status_shape"
    CHECK (("status" = 'open' AND "closed_at" IS NULL)
        OR ("status" = 'closed' AND "closed_at" IS NOT NULL
            AND "kept" + "revoked" + "left_count" = "lines")),
  ADD CONSTRAINT "access_reviews_counts"
    CHECK ("number" > 0 AND "lines" >= 0 AND "kept" >= 0 AND "revoked" >= 0 AND "left_count" >= 0
       AND "kept" + "revoked" + "left_count" <= "lines");

-- A review keeps when and what it opened with; its counts only grow while
-- open, and a closed one changes no more. Never deleted.
CREATE FUNCTION access_review_moves_forward() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."number" = OLD."number"
     AND NEW."opened_at" = OLD."opened_at"
     AND NEW."opened_by_account_id" IS NOT DISTINCT FROM OLD."opened_by_account_id"
     AND NEW."lines" = OLD."lines"
     AND NEW."kept" >= OLD."kept"
     AND NEW."revoked" >= OLD."revoked"
     AND NEW."left_count" >= OLD."left_count"
     AND OLD."status" = 'open' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'access_reviews: a review moves forward only and is never deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER access_reviews_move_forward
  BEFORE UPDATE OR DELETE ON "access_reviews"
  FOR EACH ROW EXECUTE FUNCTION access_review_moves_forward();
CREATE TRIGGER access_reviews_move_forward_truncate
  BEFORE TRUNCATE ON "access_reviews"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "access_reviews" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "access_reviews" TO jiwar_app;

ALTER TABLE "access_reviews" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "access_reviews" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "access_reviews"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE "access_review_lines" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "review_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "account_type" "account_type" NOT NULL,
    "role_id" UUID NOT NULL,
    "role_key" TEXT,
    "role_name" TEXT,
    "permissions" TEXT[] NOT NULL,
    "last_active_at" TIMESTAMPTZ(3),
    "protected" BOOLEAN NOT NULL DEFAULT false,
    "decision" TEXT,
    "decided_at" TIMESTAMPTZ(3),
    "decided_by_account_id" UUID,

    CONSTRAINT "access_review_lines_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "access_review_lines_tenant_id_id_key"
  ON "access_review_lines" ("tenant_id", "id");
-- An account is one line of a review.
CREATE UNIQUE INDEX "access_review_lines_account_key"
  ON "access_review_lines" ("tenant_id", "review_id", "account_id");
CREATE INDEX "access_review_lines_account_idx"
  ON "access_review_lines" ("tenant_id", "account_id")
  WHERE "decision" IS NULL;

ALTER TABLE "access_review_lines"
  ADD CONSTRAINT "access_review_lines_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "access_review_lines_review_fkey"
    FOREIGN KEY ("tenant_id", "review_id") REFERENCES "access_reviews"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "access_review_lines_account_fkey"
    FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "access_review_lines_decided_by_fkey"
    FOREIGN KEY ("tenant_id", "decided_by_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "access_review_lines_account_type"
    CHECK ("account_type" IN ('staff', 'manager', 'contractor')),
  -- Undecided; kept or revoked by someone else; or left (the system).
  ADD CONSTRAINT "access_review_lines_decision_shape"
    CHECK (("decision" IS NULL AND "decided_at" IS NULL AND "decided_by_account_id" IS NULL)
        OR ("decision" IN ('keep', 'revoke') AND "decided_at" IS NOT NULL
            AND "decided_by_account_id" IS NOT NULL
            AND "decided_by_account_id" <> "account_id")
        OR ("decision" = 'left' AND "decided_at" IS NOT NULL AND "decided_by_account_id" IS NULL)),
  -- The system manager is kept only.
  ADD CONSTRAINT "access_review_lines_protected_kept"
    CHECK (NOT "protected" OR "decision" IS NULL OR "decision" IN ('keep', 'left'));

-- A line keeps its snapshot; it is decided once. Never deleted.
CREATE FUNCTION access_review_line_decided_once() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."review_id" = OLD."review_id"
     AND NEW."account_id" = OLD."account_id"
     AND NEW."account_type" = OLD."account_type"
     AND NEW."role_id" = OLD."role_id"
     AND NEW."role_key" IS NOT DISTINCT FROM OLD."role_key"
     AND NEW."role_name" IS NOT DISTINCT FROM OLD."role_name"
     AND NEW."permissions" = OLD."permissions"
     AND NEW."last_active_at" IS NOT DISTINCT FROM OLD."last_active_at"
     AND NEW."protected" = OLD."protected"
     AND OLD."decision" IS NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'access_review_lines: a line keeps its snapshot and is decided once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER access_review_lines_decided_once
  BEFORE UPDATE OR DELETE ON "access_review_lines"
  FOR EACH ROW EXECUTE FUNCTION access_review_line_decided_once();
CREATE TRIGGER access_review_lines_decided_once_truncate
  BEFORE TRUNCATE ON "access_review_lines"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "access_review_lines" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "access_review_lines" TO jiwar_app;

ALTER TABLE "access_review_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "access_review_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "access_review_lines"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
