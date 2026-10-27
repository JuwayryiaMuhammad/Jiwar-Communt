-- ============================================================================
-- A unit's contracts: leases and ownership contracts, and lease renewals
-- (ADR 0062)
-- ============================================================================
--
-- The management records a contract it holds a copy of: its kind, its key
-- dates, its file and its parties (the occupancies it binds: a lease's
-- tenants, an ownership contract's owners). No signature, no money. A
-- renewal is a new lease that `renews` the one before; a mistake is
-- corrected by voiding and recording again. Every write takes the unit's
-- lock, under which a tenant occupancy holds one live lease at most. The
-- record never changes but for its set-once marks; its file goes after the
-- retention (5 years after the end, once no party lives there) or with the
-- erasure of its only party.

ALTER TABLE "files" DROP CONSTRAINT "files_content_type_for_purpose";
ALTER TABLE "files" ADD CONSTRAINT "files_content_type_for_purpose"
  CHECK (("content_type" IN ('image/jpeg', 'image/png', 'image/webp') AND "purpose" NOT IN ('data_export', 'patrol_note_audio', 'patrol_note_video', 'incident_audio', 'incident_video', 'incident_signature', 'compound_document'))
      OR ("content_type" = 'image/png' AND "purpose" = 'incident_signature')
      OR ("content_type" = 'application/pdf' AND "purpose" IN ('document', 'request_attachment', 'community_attachment', 'complaint_evidence', 'vehicle_licence', 'approval_attachment', 'board_appeal_attachment', 'expense_invoice', 'decision_appeal_attachment', 'registration_document', 'kinship_proof', 'unit_document', 'compound_document', 'contract'))
      OR ("content_type" = 'application/zip' AND "purpose" = 'data_export')
      OR ("content_type" = 'audio/mp4' AND "purpose" IN ('patrol_note_audio', 'incident_audio'))
      OR ("content_type" IN ('video/mp4', 'video/quicktime') AND "purpose" IN ('patrol_note_video', 'incident_video')));

-- What a lease's end costs, as the compound publishes it (EGP; invoiced by
-- the management, never charged here).
ALTER TABLE "tenant_settings"
  ADD COLUMN "renewal_fee" NUMERIC(12, 2),
  ADD COLUMN "move_out_fee" NUMERIC(12, 2);
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_contract_fees"
  CHECK (("renewal_fee" IS NULL OR "renewal_fee" >= 0)
     AND ("move_out_fee" IS NULL OR "move_out_fee" >= 0));

CREATE TABLE "unit_contracts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "unit_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "signed_on" DATE NOT NULL,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE,
    "notice_days" INTEGER,
    "file_id" UUID,
    "file_purged_at" TIMESTAMPTZ(3),
    "renews_id" UUID,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "voided_at" TIMESTAMPTZ(3),
    "void_reason" TEXT,
    "expiry_notified_at" TIMESTAMPTZ(3),
    CONSTRAINT "unit_contracts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "unit_contracts_tenant_id_id_key" ON "unit_contracts"("tenant_id", "id");
CREATE UNIQUE INDEX "unit_contracts_number_key" ON "unit_contracts"("tenant_id", "number");
CREATE UNIQUE INDEX "unit_contracts_file_id_key" ON "unit_contracts"("file_id") WHERE "file_id" IS NOT NULL;
CREATE INDEX "unit_contracts_unit_idx" ON "unit_contracts"("tenant_id", "unit_id", "starts_on" DESC);
CREATE INDEX "unit_contracts_expiry_idx" ON "unit_contracts"("tenant_id", "ends_on")
  WHERE "kind" = 'lease' AND "voided_at" IS NULL AND "expiry_notified_at" IS NULL;
ALTER TABLE "unit_contracts"
  ADD CONSTRAINT "unit_contracts_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_contracts_unit_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_contracts_file_fkey"
  FOREIGN KEY ("tenant_id", "file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_contracts_renews_fkey"
  FOREIGN KEY ("tenant_id", "renews_id") REFERENCES "unit_contracts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_contracts_created_by_fkey"
  FOREIGN KEY ("tenant_id", "created_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "unit_contracts" ADD CONSTRAINT "unit_contracts_number_positive"
  CHECK ("number" >= 1);
-- A lease ends, after it starts, with a notice; ownership has neither, and
-- only a lease renews another.
ALTER TABLE "unit_contracts" ADD CONSTRAINT "unit_contracts_kind_shape"
  CHECK (("kind" = 'lease' AND "ends_on" IS NOT NULL AND "notice_days" IS NOT NULL
          AND "notice_days" BETWEEN 0 AND 365)
      OR ("kind" = 'ownership' AND "ends_on" IS NULL AND "notice_days" IS NULL
          AND "renews_id" IS NULL));
ALTER TABLE "unit_contracts" ADD CONSTRAINT "unit_contracts_dates"
  CHECK ("signed_on" <= "starts_on" + 365
     AND ("ends_on" IS NULL OR "ends_on" > "starts_on"));
ALTER TABLE "unit_contracts" ADD CONSTRAINT "unit_contracts_void_shape"
  CHECK (("voided_at" IS NULL) = ("void_reason" IS NULL)
     AND ("void_reason" IS NULL OR "void_reason" IN ('data_error', 'wrong_file', 'other')));
-- A file until it is purged; once purged, never again.
ALTER TABLE "unit_contracts" ADD CONSTRAINT "unit_contracts_file_shape"
  CHECK (("file_id" IS NULL) = ("file_purged_at" IS NOT NULL));
ALTER TABLE "unit_contracts" ADD CONSTRAINT "unit_contracts_marks_after"
  CHECK (("voided_at" IS NULL OR "voided_at" >= "created_at")
     AND ("expiry_notified_at" IS NULL OR "expiry_notified_at" >= "created_at")
     AND ("file_purged_at" IS NULL OR "file_purged_at" >= "created_at"));

CREATE FUNCTION unit_contract_marks_once() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."number" = OLD."number" AND NEW."unit_id" = OLD."unit_id"
     AND NEW."kind" = OLD."kind" AND NEW."signed_on" = OLD."signed_on"
     AND NEW."starts_on" = OLD."starts_on"
     AND NEW."ends_on" IS NOT DISTINCT FROM OLD."ends_on"
     AND NEW."notice_days" IS NOT DISTINCT FROM OLD."notice_days"
     AND NEW."renews_id" IS NOT DISTINCT FROM OLD."renews_id"
     AND NEW."created_by" = OLD."created_by" AND NEW."created_at" = OLD."created_at"
     AND (OLD."voided_at" IS NULL
          OR (NEW."voided_at" = OLD."voided_at" AND NEW."void_reason" = OLD."void_reason"))
     AND (OLD."expiry_notified_at" IS NULL
          OR NEW."expiry_notified_at" = OLD."expiry_notified_at")
     AND (NEW."file_id" IS NOT DISTINCT FROM OLD."file_id"
          OR (OLD."file_id" IS NOT NULL AND NEW."file_id" IS NULL)) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'unit_contracts: a contract never changes but for its set-once marks (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER unit_contracts_marks_once
  BEFORE UPDATE OR DELETE ON "unit_contracts"
  FOR EACH ROW EXECUTE FUNCTION unit_contract_marks_once();
CREATE TRIGGER unit_contracts_no_truncate
  BEFORE TRUNCATE ON "unit_contracts"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

CREATE TABLE "unit_contract_parties" (
    "tenant_id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "occupancy_id" UUID NOT NULL,
    CONSTRAINT "unit_contract_parties_pkey" PRIMARY KEY ("contract_id", "occupancy_id")
);
CREATE INDEX "unit_contract_parties_occupancy_idx"
  ON "unit_contract_parties"("tenant_id", "occupancy_id");
ALTER TABLE "unit_contract_parties"
  ADD CONSTRAINT "unit_contract_parties_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_contract_parties_contract_fkey"
  FOREIGN KEY ("tenant_id", "contract_id") REFERENCES "unit_contracts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "unit_contract_parties_occupancy_fkey"
  FOREIGN KEY ("tenant_id", "occupancy_id") REFERENCES "unit_occupancies"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE TRIGGER unit_contract_parties_immutable
  BEFORE UPDATE OR DELETE ON "unit_contract_parties"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER unit_contract_parties_no_truncate
  BEFORE TRUNCATE ON "unit_contract_parties"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

CREATE TABLE "contract_renewals" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "occupancy_id" UUID NOT NULL,
    "requested_by" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "renewed_contract_id" UUID,
    "reason_code" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "closed_at" TIMESTAMPTZ(3),
    "closed_by" UUID,
    CONSTRAINT "contract_renewals_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "contract_renewals_tenant_id_id_key" ON "contract_renewals"("tenant_id", "id");
CREATE UNIQUE INDEX "contract_renewals_one_open"
  ON "contract_renewals"("tenant_id", "contract_id") WHERE "status" = 'open';
CREATE INDEX "contract_renewals_queue_idx" ON "contract_renewals"("tenant_id", "status", "created_at");
ALTER TABLE "contract_renewals"
  ADD CONSTRAINT "contract_renewals_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "contract_renewals_contract_fkey"
  FOREIGN KEY ("tenant_id", "contract_id") REFERENCES "unit_contracts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "contract_renewals_occupancy_fkey"
  FOREIGN KEY ("tenant_id", "occupancy_id") REFERENCES "unit_occupancies"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "contract_renewals_requested_by_fkey"
  FOREIGN KEY ("tenant_id", "requested_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "contract_renewals_renewed_fkey"
  FOREIGN KEY ("tenant_id", "renewed_contract_id") REFERENCES "unit_contracts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "contract_renewals_closed_by_fkey"
  FOREIGN KEY ("tenant_id", "closed_by") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "contract_renewals" ADD CONSTRAINT "contract_renewals_shape"
  CHECK ("status" IN ('open', 'renewed', 'declined', 'withdrawn')
     AND ("status" = 'open') = ("closed_at" IS NULL)
     AND ("status" = 'renewed') = ("renewed_contract_id" IS NOT NULL)
     AND ("status" = 'declined') = ("reason_code" IS NOT NULL)
     AND ("closed_by" IS NULL OR "status" <> 'open')
     AND ("reason_code" IS NULL
          OR "reason_code" IN ('owner_declined', 'dues_outstanding', 'terms_not_agreed', 'other'))
     AND ("closed_at" IS NULL OR "closed_at" >= "created_at"));

CREATE FUNCTION contract_renewal_closes_once() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD."status" = 'open' AND NEW."status" <> 'open'
     AND NEW."id" = OLD."id" AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."contract_id" = OLD."contract_id"
     AND NEW."occupancy_id" = OLD."occupancy_id"
     AND NEW."requested_by" = OLD."requested_by"
     AND NEW."created_at" = OLD."created_at" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'contract_renewals: a request closes once and otherwise never changes (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER contract_renewals_closes_once
  BEFORE UPDATE OR DELETE ON "contract_renewals"
  FOR EACH ROW EXECUTE FUNCTION contract_renewal_closes_once();
CREATE TRIGGER contract_renewals_no_truncate
  BEFORE TRUNCATE ON "contract_renewals"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- Contracts and renewals are locked FOR UPDATE (void, the sweeps, a
-- decision): UPDATE, which their triggers limit. Parties are written once.
REVOKE ALL ON "unit_contracts", "unit_contract_parties", "contract_renewals" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "unit_contracts", "contract_renewals" TO jiwar_app;
GRANT SELECT, INSERT ON "unit_contract_parties" TO jiwar_app;
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['unit_contracts', 'unit_contract_parties', 'contract_renewals'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
