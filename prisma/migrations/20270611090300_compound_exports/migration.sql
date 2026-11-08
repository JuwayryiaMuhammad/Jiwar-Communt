-- ============================================================================
-- The compound's export (ADR 0086).
--
-- The manager (`compound.export`) asks, behind a fresh step-up, for the
-- compound's operational data: a zip of fixed tables and columns, one CSV
-- each, written in code and pinned by a unit test — the register, the work
-- and its costs, the stock, the common meters, the budget, the capital
-- plans. Never a person: no name, phone, email, national ID, free text,
-- unit occupancy, money owed by a unit or a household's meter. A person's
-- data leaves through the per-account export (ADR 0036) and nowhere else.
--
-- One at a time per compound (a partial unique index backs the service's
-- check under its advisory lock) and one a day. Built by a sweep as the
-- data exports are (leased, streamed into the private bucket), ready for 7
-- days to whoever asked, then its file is deleted. Every step is audited
-- with ids and counts only.
-- ============================================================================

CREATE TABLE "compound_exports" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "requested_by_account_id" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(3),
    "object_id" UUID,
    "file_id" UUID,
    "tables" INTEGER,
    "rows" BIGINT,
    "ready_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3),
    "ended_at" TIMESTAMPTZ(3),
    "failure_code" TEXT,
    CONSTRAINT "compound_exports_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "compound_exports_tenant_id_id_key" ON "compound_exports"("tenant_id", "id");
-- One being prepared at a time.
CREATE UNIQUE INDEX "compound_exports_one_active"
  ON "compound_exports"("tenant_id") WHERE "status" IN ('pending', 'building');
CREATE INDEX "compound_exports_list_idx" ON "compound_exports"("tenant_id", "requested_at" DESC, "id" DESC);
CREATE INDEX "compound_exports_status_idx" ON "compound_exports"("tenant_id", "status");
ALTER TABLE "compound_exports" ADD CONSTRAINT "compound_exports_tenant_id_requested_by_fkey"
  FOREIGN KEY ("tenant_id", "requested_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "compound_exports" ADD CONSTRAINT "compound_exports_tenant_id_file_id_fkey"
  FOREIGN KEY ("tenant_id", "file_id") REFERENCES "files"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "compound_exports" ADD CONSTRAINT "compound_exports_status_known"
  CHECK ("status" IN ('pending', 'building', 'ready', 'expired', 'failed')
     AND "attempts" >= 0);
-- Ready: its file, when and until when, what it holds. Ended (expired or
-- failed): when, and no file; a failure says why.
ALTER TABLE "compound_exports" ADD CONSTRAINT "compound_exports_ready_shape"
  CHECK ((("status" = 'ready') = ("file_id" IS NOT NULL))
     AND (("status" = 'ready') <= ("ready_at" IS NOT NULL AND "expires_at" IS NOT NULL
                                    AND "tables" IS NOT NULL AND "rows" IS NOT NULL))
     AND (("status" IN ('expired', 'failed')) = ("ended_at" IS NOT NULL))
     AND (("status" = 'failed') = ("failure_code" IS NOT NULL)));

REVOKE ALL ON "compound_exports" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "compound_exports" TO jiwar_app;
ALTER TABLE "compound_exports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "compound_exports" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "compound_exports"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
