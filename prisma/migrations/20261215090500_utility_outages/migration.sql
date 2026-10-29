-- ============================================================================
-- Utility outages (ADR 0066): water, electricity or gas cut off in the whole
-- compound or in some of its buildings, from one instant to another (two
-- weeks at most). The residents of its buildings are told 48 hours ahead —
-- at once when it starts sooner or was not planned — and each one told is
-- recorded, so its end, its cancellation and a new start go to exactly those
-- told. Ended once or cancelled once.
-- ============================================================================

CREATE TABLE "utility_outages" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "planned" BOOLEAN NOT NULL,
    "scope" TEXT NOT NULL,
    "buildings" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "note" TEXT,
    "notified_at" TIMESTAMPTZ(3),
    "announced_starts_at" TIMESTAMPTZ(3),
    "ended_at" TIMESTAMPTZ(3),
    "ended_by_account_id" UUID,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by_account_id" UUID,
    "cancel_reason" TEXT,
    "created_by_account_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "utility_outages_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "utility_outages_tenant_id_id_key" ON "utility_outages"("tenant_id", "id");
CREATE INDEX "utility_outages_list_idx" ON "utility_outages"("tenant_id", "starts_at", "id");
-- What the 48-hour sweep looks for: planned, untold, still on.
CREATE INDEX "utility_outages_untold_idx" ON "utility_outages"("tenant_id", "starts_at")
  WHERE "notified_at" IS NULL AND "cancelled_at" IS NULL AND "ended_at" IS NULL;
ALTER TABLE "utility_outages" ADD CONSTRAINT "utility_outages_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "utility_outages" ADD CONSTRAINT "utility_outages_ended_by_fkey"
  FOREIGN KEY ("tenant_id", "ended_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "utility_outages" ADD CONSTRAINT "utility_outages_cancelled_by_fkey"
  FOREIGN KEY ("tenant_id", "cancelled_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "utility_outages" ADD CONSTRAINT "utility_outages_created_by_fkey"
  FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- REASON_CODES.outageKind.
ALTER TABLE "utility_outages" ADD CONSTRAINT "utility_outages_kind_known"
  CHECK ("kind" IN ('water', 'electricity', 'gas', 'other'));
-- OUTAGE_SCOPES in src/maintenance/outages/outage-rules.ts: the whole
-- compound, with no building named, or 1 to 50 buildings.
ALTER TABLE "utility_outages" ADD CONSTRAINT "utility_outages_scope_shape"
  CHECK (("scope" = 'compound' AND cardinality("buildings") = 0)
      OR ("scope" = 'buildings' AND cardinality("buildings") BETWEEN 1 AND 50));
ALTER TABLE "utility_outages" ADD CONSTRAINT "utility_outages_window"
  CHECK ("ends_at" > "starts_at" AND "ends_at" <= "starts_at" + interval '14 days');
ALTER TABLE "utility_outages" ADD CONSTRAINT "utility_outages_note_length"
  CHECK ("note" IS NULL OR char_length("note") BETWEEN 1 AND 500);
-- Told with the start it was told; ended or cancelled once, never both
-- (REASON_CODES.outageCancel).
ALTER TABLE "utility_outages" ADD CONSTRAINT "utility_outages_state_shape"
  CHECK (("notified_at" IS NULL) = ("announced_starts_at" IS NULL)
     AND ("cancelled_at" IS NULL) = ("cancel_reason" IS NULL)
     AND ("ended_at" IS NULL OR "cancelled_at" IS NULL)
     AND ("cancel_reason" IS NULL
          OR "cancel_reason" IN ('not_needed', 'rescheduled', 'entered_in_error', 'other')));

-- An ended or cancelled outage never changes; its kind, its planning and
-- when it was made never do. An erasure may null who acted, nothing else.
CREATE FUNCTION "utility_outages_close_once"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'an outage is never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."kind" <> OLD."kind" OR NEW."planned" <> OLD."planned" OR NEW."created_at" <> OLD."created_at"
     OR (OLD."notified_at" IS NOT NULL AND NEW."notified_at" IS DISTINCT FROM OLD."notified_at")
     OR ((OLD."ended_at" IS NOT NULL OR OLD."cancelled_at" IS NOT NULL) AND (
          NEW."ended_at" IS DISTINCT FROM OLD."ended_at"
       OR NEW."cancelled_at" IS DISTINCT FROM OLD."cancelled_at"
       OR NEW."cancel_reason" IS DISTINCT FROM OLD."cancel_reason"
       OR NEW."starts_at" <> OLD."starts_at" OR NEW."ends_at" <> OLD."ends_at"
       OR NEW."scope" <> OLD."scope" OR NEW."buildings" <> OLD."buildings"
       OR NEW."note" IS DISTINCT FROM OLD."note"
       OR NEW."announced_starts_at" IS DISTINCT FROM OLD."announced_starts_at"
       OR (NEW."ended_by_account_id" IS DISTINCT FROM OLD."ended_by_account_id"
           AND NEW."ended_by_account_id" IS NOT NULL)
       OR (NEW."cancelled_by_account_id" IS DISTINCT FROM OLD."cancelled_by_account_id"
           AND NEW."cancelled_by_account_id" IS NOT NULL))) THEN
    RAISE EXCEPTION 'an ended or cancelled outage never changes'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "utility_outages_close_once" BEFORE UPDATE OR DELETE ON "utility_outages"
  FOR EACH ROW EXECUTE FUNCTION "utility_outages_close_once"();

CREATE TABLE "utility_outage_recipients" (
    "tenant_id" UUID NOT NULL,
    "outage_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "told_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "utility_outage_recipients_pkey" PRIMARY KEY ("outage_id", "account_id")
);
CREATE INDEX "utility_outage_recipients_account_idx" ON "utility_outage_recipients"("tenant_id", "account_id");
ALTER TABLE "utility_outage_recipients" ADD CONSTRAINT "utility_outage_recipients_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "utility_outage_recipients" ADD CONSTRAINT "utility_outage_recipients_outage_fkey"
  FOREIGN KEY ("tenant_id", "outage_id") REFERENCES "utility_outages"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "utility_outage_recipients" ADD CONSTRAINT "utility_outage_recipients_account_fkey"
  FOREIGN KEY ("tenant_id", "account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ----------------------------------------------------------------------------
-- Grants: an outage changes in place under FOR UPDATE; who was told is only
-- added (ON CONFLICT DO NOTHING).
-- ----------------------------------------------------------------------------
REVOKE ALL ON "utility_outages", "utility_outage_recipients" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "utility_outages" TO jiwar_app;
GRANT SELECT, INSERT ON "utility_outage_recipients" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['utility_outages', 'utility_outage_recipients'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
