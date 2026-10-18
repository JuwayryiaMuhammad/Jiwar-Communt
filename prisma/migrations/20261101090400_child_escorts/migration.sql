-- ============================================================================
-- Children (ADR 0054): who may collect a child, and the personal pickup code.
-- ============================================================================
--
-- An escort belongs to one control (one period of a child's exit control)
-- and is one of: an adult of the household (an account), one of the unit's
-- domestic workers (an engagement), or an outside person (a name, a phone,
-- an optional photo) who gets a personal pickup code: a QR `JWP1.<token>`,
-- a 6-digit code derived from it, and a link with the token in the
-- fragment. Only HMACs are kept: the code's and the QR's, bound to the
-- compound, and the link's in the global `child_pickup_links` pointer.
--
-- Each escort is valid from a day, until a day or open-ended, on a weekly
-- schedule or at any time, at a post (a gate or a zone) or anywhere.
-- Revoked once, never deleted. The codes, the photo and the link die with
-- the revocation; an outside escort's name and phone are cleared 30 days
-- after it (`pii_cleared_at`), when the household's records of their
-- pickups are gone too.

CREATE TYPE "child_escort_kind" AS ENUM ('adult', 'worker', 'outside');

CREATE TABLE "child_escorts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "control_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "kind" "child_escort_kind" NOT NULL,
    "account_id" UUID,
    "engagement_id" UUID,
    "full_name" TEXT,
    "phone" TEXT,
    "photo_file_id" UUID,
    "pickup_code_hash" CHAR(64),
    "pickup_qr_hash" CHAR(64),
    "pickup_issued_at" TIMESTAMPTZ(3),
    "valid_from" DATE NOT NULL,
    "valid_until" DATE,
    "schedule" JSONB,
    "gate_id" UUID,
    "place_id" UUID,
    "revoked_at" TIMESTAMPTZ(3),
    "revoke_reason" TEXT,
    "revoked_by_account_id" UUID,
    "pii_cleared_at" TIMESTAMPTZ(3),
    "created_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "child_escorts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "child_escorts_tenant_id_id_key" ON "child_escorts"("tenant_id", "id");
-- One live escort per person and child.
CREATE UNIQUE INDEX "child_escorts_live_account"
  ON "child_escorts"("tenant_id", "control_id", "account_id")
  WHERE "revoked_at" IS NULL AND "account_id" IS NOT NULL;
CREATE UNIQUE INDEX "child_escorts_live_engagement"
  ON "child_escorts"("tenant_id", "control_id", "engagement_id")
  WHERE "revoked_at" IS NULL AND "engagement_id" IS NOT NULL;
-- A typed or scanned pickup code names one live escort of the compound.
CREATE UNIQUE INDEX "child_escorts_live_code"
  ON "child_escorts"("tenant_id", "pickup_code_hash") WHERE "pickup_code_hash" IS NOT NULL;
CREATE UNIQUE INDEX "child_escorts_live_qr"
  ON "child_escorts"("tenant_id", "pickup_qr_hash") WHERE "pickup_qr_hash" IS NOT NULL;
CREATE INDEX "child_escorts_control_idx" ON "child_escorts"("tenant_id", "control_id");
CREATE INDEX "child_escorts_account_idx" ON "child_escorts"("tenant_id", "account_id")
  WHERE "account_id" IS NOT NULL;
CREATE INDEX "child_escorts_pii_idx" ON "child_escorts"("tenant_id", "revoked_at")
  WHERE "kind" = 'outside' AND "pii_cleared_at" IS NULL;

ALTER TABLE "child_escorts"
  ADD CONSTRAINT "child_escorts_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  -- The control, and its unit with it.
  ADD CONSTRAINT "child_escorts_control_fkey"
    FOREIGN KEY ("tenant_id", "control_id", "unit_id") REFERENCES "child_controls"("tenant_id", "id", "unit_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "child_escorts_tenant_id_account_id_fkey"
    FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "child_escorts_tenant_id_engagement_id_fkey"
    FOREIGN KEY ("tenant_id", "engagement_id") REFERENCES "worker_engagements"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "child_escorts_tenant_id_photo_file_id_fkey"
    FOREIGN KEY ("tenant_id", "photo_file_id") REFERENCES "files"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "child_escorts_tenant_id_gate_id_fkey"
    FOREIGN KEY ("tenant_id", "gate_id") REFERENCES "gates"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "child_escorts_tenant_id_place_id_fkey"
    FOREIGN KEY ("tenant_id", "place_id") REFERENCES "places"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "child_escorts_tenant_id_revoked_by_account_id_fkey"
    FOREIGN KEY ("tenant_id", "revoked_by_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "child_escorts_tenant_id_created_by_account_id_fkey"
    FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "child_escorts"
  -- Who the escort is, by kind: an account, an engagement, or a person
  -- with a name and a phone (until they are cleared, after a revocation).
  ADD CONSTRAINT "child_escorts_kind_shape"
    CHECK (CASE "kind"
             WHEN 'adult' THEN "account_id" IS NOT NULL AND "engagement_id" IS NULL
             WHEN 'worker' THEN "engagement_id" IS NOT NULL AND "account_id" IS NULL
             ELSE "account_id" IS NULL AND "engagement_id" IS NULL
                  AND (("full_name" IS NOT NULL AND "phone" IS NOT NULL)
                       OR "pii_cleared_at" IS NOT NULL)
           END),
  ADD CONSTRAINT "child_escorts_personal_only_outside"
    CHECK ("kind" = 'outside'
           OR ("full_name" IS NULL AND "phone" IS NULL AND "photo_file_id" IS NULL)),
  ADD CONSTRAINT "child_escorts_name_length"
    CHECK ("full_name" IS NULL OR char_length("full_name") BETWEEN 1 AND 80),
  ADD CONSTRAINT "child_escorts_phone_shape"
    CHECK ("phone" IS NULL OR "phone" ~ '^\+[1-9][0-9]{6,14}$'),
  -- The pickup code: an outside escort's, exactly while live; the code,
  -- the QR and when they were issued go together.
  ADD CONSTRAINT "child_escorts_pickup_while_live"
    CHECK ((("kind" = 'outside') AND ("revoked_at" IS NULL)) = ("pickup_code_hash" IS NOT NULL)
           AND ("pickup_code_hash" IS NULL) = ("pickup_qr_hash" IS NULL)
           AND ("pickup_code_hash" IS NULL) = ("pickup_issued_at" IS NULL)),
  ADD CONSTRAINT "child_escorts_pickup_hash_shape"
    CHECK ("pickup_code_hash" IS NULL
           OR ("pickup_code_hash" ~ '^[0-9a-f]{64}$' AND "pickup_qr_hash" ~ '^[0-9a-f]{64}$')),
  ADD CONSTRAINT "child_escorts_photo_while_live"
    CHECK ("revoked_at" IS NULL OR "photo_file_id" IS NULL),
  ADD CONSTRAINT "child_escorts_validity"
    CHECK ("valid_until" IS NULL OR "valid_until" >= "valid_from"),
  ADD CONSTRAINT "child_escorts_one_post"
    CHECK (num_nonnulls("gate_id", "place_id") <= 1),
  ADD CONSTRAINT "child_escorts_revoked_shape"
    CHECK (("revoked_at" IS NULL) = ("revoke_reason" IS NULL)
           AND ("revoked_by_account_id" IS NULL OR "revoke_reason" IS NOT DISTINCT FROM 'household')
           AND ("revoke_reason" IS DISTINCT FROM 'household' OR "revoked_by_account_id" IS NOT NULL)),
  ADD CONSTRAINT "child_escorts_revoke_reason"
    CHECK ("revoke_reason" IS NULL OR "revoke_reason" IN ('household', 'left_household', 'control_off')),
  -- Cleared only after a revocation, and then both are gone.
  ADD CONSTRAINT "child_escorts_pii_cleared_shape"
    CHECK ("pii_cleared_at" IS NULL
           OR ("revoked_at" IS NOT NULL AND "full_name" IS NULL AND "phone" IS NULL));

-- Who the escort is and for which child never changes; it is revoked once,
-- and then only an outside escort's name and phone may be cleared, once.
-- The codes change only while live, to a later issue. Never deleted.
CREATE FUNCTION child_escort_is_kept() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."control_id" = OLD."control_id"
     AND NEW."unit_id" = OLD."unit_id"
     AND NEW."kind" = OLD."kind"
     AND NEW."account_id" IS NOT DISTINCT FROM OLD."account_id"
     AND NEW."engagement_id" IS NOT DISTINCT FROM OLD."engagement_id"
     AND NEW."created_by_account_id" = OLD."created_by_account_id"
     AND NEW."created_at" = OLD."created_at"
     AND (OLD."revoked_at" IS NULL
          OR (NEW."revoked_at" = OLD."revoked_at"
              AND NEW."revoke_reason" = OLD."revoke_reason"
              AND NEW."revoked_by_account_id" IS NOT DISTINCT FROM OLD."revoked_by_account_id"
              AND NEW."valid_from" = OLD."valid_from"
              AND NEW."valid_until" IS NOT DISTINCT FROM OLD."valid_until"
              AND NEW."schedule" IS NOT DISTINCT FROM OLD."schedule"
              AND NEW."gate_id" IS NOT DISTINCT FROM OLD."gate_id"
              AND NEW."place_id" IS NOT DISTINCT FROM OLD."place_id"
              AND NEW."photo_file_id" IS NOT DISTINCT FROM OLD."photo_file_id"
              AND NEW."pickup_code_hash" IS NOT DISTINCT FROM OLD."pickup_code_hash"
              AND NEW."pickup_qr_hash" IS NOT DISTINCT FROM OLD."pickup_qr_hash"
              AND NEW."pickup_issued_at" IS NOT DISTINCT FROM OLD."pickup_issued_at"
              AND (NEW."pii_cleared_at" IS NOT DISTINCT FROM OLD."pii_cleared_at"
                   AND NEW."full_name" IS NOT DISTINCT FROM OLD."full_name"
                   AND NEW."phone" IS NOT DISTINCT FROM OLD."phone"
                   OR (OLD."pii_cleared_at" IS NULL AND NEW."pii_cleared_at" IS NOT NULL
                       AND NEW."full_name" IS NULL AND NEW."phone" IS NULL))))
     AND (OLD."revoked_at" IS NOT NULL
          OR (NEW."full_name" IS NOT DISTINCT FROM OLD."full_name"
              AND NEW."phone" IS NOT DISTINCT FROM OLD."phone"
              AND NEW."pii_cleared_at" IS NULL))
     AND (NEW."pickup_code_hash" IS NOT DISTINCT FROM OLD."pickup_code_hash"
          OR NEW."revoked_at" IS NOT NULL
          OR NEW."pickup_issued_at" > OLD."pickup_issued_at") THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'child_escorts: who may collect which child never changes; revoked once, never deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER child_escorts_kept
  BEFORE UPDATE OR DELETE ON "child_escorts"
  FOR EACH ROW EXECUTE FUNCTION child_escort_is_kept();
CREATE TRIGGER child_escorts_kept_truncate
  BEFORE TRUNCATE ON "child_escorts"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

REVOKE ALL ON "child_escorts" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "child_escorts" TO jiwar_app;

ALTER TABLE "child_escorts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "child_escorts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "child_escorts"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Global, like visitor_pass_links: the public pickup page knows no compound
-- yet. No RLS, no personal data. Inserted with the code, deleted when it is
-- reissued or the escort is revoked.
CREATE TABLE "child_pickup_links" (
    "token_hash" CHAR(64) NOT NULL,
    "tenant_id" UUID NOT NULL,
    "escort_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "child_pickup_links_pkey" PRIMARY KEY ("token_hash")
);
CREATE INDEX "child_pickup_links_escort_id_idx" ON "child_pickup_links"("escort_id");
ALTER TABLE "child_pickup_links" ADD CONSTRAINT "child_pickup_links_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
REVOKE ALL ON "child_pickup_links" FROM jiwar_app;
GRANT SELECT, INSERT, DELETE ON "child_pickup_links" TO jiwar_app;
