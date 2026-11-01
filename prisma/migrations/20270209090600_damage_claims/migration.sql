-- ============================================================================
-- Fit-out completion (ADR 0074): damage claims on a works permit.
-- ============================================================================
--
-- The management (`permits.manage`) claims damage the works did: a code
-- (REASON_CODES.damageClaim), its words the household reads, an amount in
-- EGP, an optional common area and one to six `fitout_photo` files. The
-- requester and the unit's primary are told; either appeals it once within
-- 14 days (their words, an optional `damage_appeal_photo`), and the
-- management upholds the claim (open again) or accepts the appeal (the
-- claim withdrawn, `appeal_accepted`). The management withdraws an open
-- claim with a code (REASON_CODES.damageClaimWithdraw). An open claim
-- whose appeal was decided, or whose window passed, is settled once: taken
-- from the works deposit named on the permit as far as it holds, the rest
-- owed as a `damage` invoice of the unit's through the charges port
-- (ADR 0070); the two always add up to the amount.
--
-- Numbers (`DC-`) are the compound's, under an advisory lock taken last.
-- The terms never change; the status moves forward as above; the appeal's
-- words and photo go at the appellant's erasure (`appeal_text_cleared_at`).
-- The unit is the permit's (a composite key on the permit's unit).

CREATE TABLE "permit_damage_claims" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "permit_id" UUID NOT NULL,
    "permit_kind" "unit_permit_kind" NOT NULL DEFAULT 'works',
    "unit_id" UUID NOT NULL,
    "common_area_id" UUID,
    "reason_code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amount" NUMERIC(12, 2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "raised_by" UUID NOT NULL,
    "raised_at" TIMESTAMPTZ(3) NOT NULL,
    "appeal_until" TIMESTAMPTZ(3) NOT NULL,
    "appeal_text" TEXT,
    "appeal_photo_file_id" UUID,
    "appealed_by" UUID,
    "appealed_at" TIMESTAMPTZ(3),
    "appeal_text_cleared_at" TIMESTAMPTZ(3),
    "appeal_decision" TEXT,
    "appeal_decided_by" UUID,
    "appeal_decided_at" TIMESTAMPTZ(3),
    "withdrawn_at" TIMESTAMPTZ(3),
    "withdrawn_by" UUID,
    "withdraw_reason" TEXT,
    "settled_at" TIMESTAMPTZ(3),
    "settled_by" UUID,
    "deducted" NUMERIC(12, 2),
    "charged" NUMERIC(12, 2),
    CONSTRAINT "permit_damage_claims_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "permit_damage_claims_tenant_id_id_key" ON "permit_damage_claims"("tenant_id", "id");
CREATE UNIQUE INDEX "permit_damage_claims_number_key" ON "permit_damage_claims"("tenant_id", "number");
CREATE UNIQUE INDEX "permit_damage_claims_appeal_photo_key"
  ON "permit_damage_claims"("appeal_photo_file_id") WHERE "appeal_photo_file_id" IS NOT NULL;
CREATE INDEX "permit_damage_claims_permit_idx" ON "permit_damage_claims"("tenant_id", "permit_id", "raised_at");
CREATE INDEX "permit_damage_claims_open_idx" ON "permit_damage_claims"("tenant_id", "raised_at")
  WHERE "status" IN ('open', 'under_appeal');
ALTER TABLE "permit_damage_claims"
  ADD CONSTRAINT "permit_damage_claims_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "permit_damage_claims_permit_fkey"
  FOREIGN KEY ("tenant_id", "permit_id", "permit_kind")
  REFERENCES "unit_permits"("tenant_id", "id", "kind")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "permit_damage_claims_permit_unit_fkey"
  FOREIGN KEY ("tenant_id", "permit_id", "unit_id")
  REFERENCES "unit_permits"("tenant_id", "id", "unit_id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "permit_damage_claims_common_area_fkey"
  FOREIGN KEY ("tenant_id", "common_area_id") REFERENCES "common_areas"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "permit_damage_claims_appeal_photo_fkey"
  FOREIGN KEY ("tenant_id", "appeal_photo_file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "permit_damage_claims_raised_by_fkey"
  FOREIGN KEY ("tenant_id", "raised_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "permit_damage_claims_appealed_by_fkey"
  FOREIGN KEY ("tenant_id", "appealed_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "permit_damage_claims_appeal_decided_by_fkey"
  FOREIGN KEY ("tenant_id", "appeal_decided_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "permit_damage_claims_withdrawn_by_fkey"
  FOREIGN KEY ("tenant_id", "withdrawn_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "permit_damage_claims_settled_by_fkey"
  FOREIGN KEY ("tenant_id", "settled_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- The terms: REASON_CODES.damageClaim, words, an amount, a window to appeal.
ALTER TABLE "permit_damage_claims" ADD CONSTRAINT "permit_damage_claims_terms"
  CHECK ("permit_kind" = 'works'
     AND "number" >= 1
     AND "reason_code" IN ('common_area_damage', 'lift_damage', 'facade_damage', 'debris_left', 'other')
     AND char_length("description") BETWEEN 1 AND 1000
     AND "amount" > 0 AND "amount" <= 1000000
     AND "appeal_until" > "raised_at");
-- The status and the columns that say it, set together.
ALTER TABLE "permit_damage_claims" ADD CONSTRAINT "permit_damage_claims_state_shape"
  CHECK ("status" IN ('open', 'under_appeal', 'withdrawn', 'settled')
     -- The appeal: words until cleared at the appellant's erasure.
     AND ("appealed_at" IS NULL) = ("appealed_by" IS NULL)
     AND ("appeal_text" IS NULL OR "appealed_at" IS NOT NULL)
     AND ("appeal_photo_file_id" IS NULL OR "appealed_at" IS NOT NULL)
     AND ("appeal_text_cleared_at" IS NULL OR "appealed_at" IS NOT NULL)
     AND ("appealed_at" IS NULL OR "appeal_text" IS NOT NULL OR "appeal_text_cleared_at" IS NOT NULL)
     AND ("appeal_text" IS NULL OR char_length("appeal_text") BETWEEN 1 AND 1000)
     AND ("appealed_at" IS NULL OR "appealed_at" >= "raised_at")
     -- Under appeal: appealed and not decided.
     AND ("status" = 'under_appeal') = ("appealed_at" IS NOT NULL AND "appeal_decided_at" IS NULL)
     AND ("appeal_decided_at" IS NULL) = ("appeal_decision" IS NULL)
     AND ("appeal_decided_at" IS NULL) = ("appeal_decided_by" IS NULL)
     AND ("appeal_decided_at" IS NULL OR "appealed_at" IS NOT NULL)
     AND ("appeal_decision" IS NULL OR "appeal_decision" IN ('upheld', 'accepted'))
     -- Withdrawn: with its code; an accepted appeal withdraws it.
     AND ("status" = 'withdrawn') = ("withdrawn_at" IS NOT NULL)
     AND ("withdrawn_at" IS NULL) = ("withdrawn_by" IS NULL)
     AND ("withdrawn_at" IS NULL) = ("withdraw_reason" IS NULL)
     AND ("withdraw_reason" IS NULL
          OR "withdraw_reason" IN ('appeal_accepted', 'repaired_by_unit', 'issued_in_error', 'other'))
     AND ("appeal_decision" IS DISTINCT FROM 'accepted'
          OR ("status" = 'withdrawn' AND "withdraw_reason" = 'appeal_accepted'))
     -- Settled: from the deposit and as a charge, adding up to the amount.
     AND ("status" = 'settled') = ("settled_at" IS NOT NULL)
     AND ("settled_at" IS NULL) = ("settled_by" IS NULL)
     AND ("settled_at" IS NULL) = ("deducted" IS NULL)
     AND ("settled_at" IS NULL) = ("charged" IS NULL)
     AND ("deducted" IS NULL OR ("deducted" >= 0 AND "charged" >= 0 AND "deducted" + "charged" = "amount")));

-- The terms never change; the status moves forward once each way; the
-- appeal's words and photo are cleared once, and nothing else then.
CREATE FUNCTION permit_damage_claim_moves() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."number" = OLD."number"
     AND NEW."permit_id" = OLD."permit_id"
     AND NEW."permit_kind" = OLD."permit_kind"
     AND NEW."unit_id" = OLD."unit_id"
     AND NEW."common_area_id" IS NOT DISTINCT FROM OLD."common_area_id"
     AND NEW."reason_code" = OLD."reason_code"
     AND NEW."description" = OLD."description"
     AND NEW."amount" = OLD."amount"
     AND NEW."raised_by" = OLD."raised_by"
     AND NEW."raised_at" = OLD."raised_at"
     AND NEW."appeal_until" = OLD."appeal_until"
     -- An appeal, once lodged, keeps who and when.
     AND (OLD."appealed_at" IS NULL
          OR (NEW."appealed_at" = OLD."appealed_at" AND NEW."appealed_by" = OLD."appealed_by"))
     -- A decision, a withdrawal and a settlement are made once.
     AND (OLD."appeal_decided_at" IS NULL
          OR (NEW."appeal_decided_at" = OLD."appeal_decided_at"
              AND NEW."appeal_decision" = OLD."appeal_decision"
              AND NEW."appeal_decided_by" = OLD."appeal_decided_by"))
     AND (OLD."withdrawn_at" IS NULL
          OR (NEW."withdrawn_at" = OLD."withdrawn_at"
              AND NEW."withdraw_reason" = OLD."withdraw_reason"
              AND NEW."withdrawn_by" = OLD."withdrawn_by"))
     AND (OLD."settled_at" IS NULL
          OR (NEW."settled_at" = OLD."settled_at"
              AND NEW."settled_by" = OLD."settled_by"
              AND NEW."deducted" = OLD."deducted"
              AND NEW."charged" = OLD."charged"))
     -- The words: kept, or cleared once (with the photo).
     AND ((NEW."appeal_text" IS NOT DISTINCT FROM OLD."appeal_text"
           AND NEW."appeal_photo_file_id" IS NOT DISTINCT FROM OLD."appeal_photo_file_id"
           AND NEW."appeal_text_cleared_at" IS NOT DISTINCT FROM OLD."appeal_text_cleared_at")
          OR (OLD."appeal_text_cleared_at" IS NULL AND OLD."appealed_at" IS NOT NULL
              AND NEW."appeal_text" IS NULL AND NEW."appeal_photo_file_id" IS NULL
              AND NEW."appeal_text_cleared_at" IS NOT NULL)
          OR (OLD."appealed_at" IS NULL AND NEW."appealed_at" IS NOT NULL))
     -- The status: open → under_appeal | withdrawn | settled;
     -- under_appeal → open | withdrawn; nothing from withdrawn or settled.
     AND (NEW."status" = OLD."status"
          OR (OLD."status" = 'open' AND NEW."status" IN ('under_appeal', 'withdrawn', 'settled'))
          OR (OLD."status" = 'under_appeal' AND NEW."status" IN ('open', 'withdrawn'))) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'permit_damage_claims: a claim keeps its terms and moves forward once (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER permit_damage_claims_moves
  BEFORE UPDATE OR DELETE ON "permit_damage_claims"
  FOR EACH ROW EXECUTE FUNCTION permit_damage_claim_moves();
CREATE TRIGGER permit_damage_claims_no_truncate
  BEFORE TRUNCATE ON "permit_damage_claims"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- A claim's photos: attached when it is raised, never detached.
CREATE TABLE "permit_damage_claim_photos" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "claim_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "permit_damage_claim_photos_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "permit_damage_claim_photos_file_id_key" ON "permit_damage_claim_photos"("file_id");
CREATE INDEX "permit_damage_claim_photos_claim_idx" ON "permit_damage_claim_photos"("tenant_id", "claim_id");
ALTER TABLE "permit_damage_claim_photos"
  ADD CONSTRAINT "permit_damage_claim_photos_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "permit_damage_claim_photos_claim_fkey"
  FOREIGN KEY ("tenant_id", "claim_id") REFERENCES "permit_damage_claims"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "permit_damage_claim_photos_file_fkey"
  FOREIGN KEY ("tenant_id", "file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE TRIGGER permit_damage_claim_photos_immutable
  BEFORE UPDATE OR DELETE ON "permit_damage_claim_photos"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER permit_damage_claim_photos_no_truncate
  BEFORE TRUNCATE ON "permit_damage_claim_photos"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

GRANT SELECT, INSERT, UPDATE ON "permit_damage_claims" TO jiwar_app;
GRANT SELECT, INSERT ON "permit_damage_claim_photos" TO jiwar_app;
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['permit_damage_claims', 'permit_damage_claim_photos'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
