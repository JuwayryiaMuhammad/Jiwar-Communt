-- ============================================================================
-- Why a wage obligation was closed (ADR 0037).
--
-- A household's recorded payment settles nothing: a manager closes the
-- obligation, with a code from a closed list (text, like every reason code;
-- the list lives in the application). Nothing settled an obligation before
-- this migration, so the shape below holds for every existing row: open
-- rows carry none of the three columns, settled rows all of them.
-- ============================================================================

ALTER TABLE "worker_wage_obligations" ADD COLUMN "settle_reason_code" TEXT;
ALTER TABLE "worker_wage_obligations" ADD CONSTRAINT "worker_wage_obligations_settled_shape"
  CHECK (
    ("settled_at" IS NULL AND "settled_by" IS NULL AND "settle_reason_code" IS NULL)
    OR ("settled_at" IS NOT NULL AND "settled_by" IS NOT NULL AND "settle_reason_code" IS NOT NULL)
  );
