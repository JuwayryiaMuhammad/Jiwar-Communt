-- ============================================================================
-- The management starts a lockdown (ADR 0087, amending ADR 0053): from the
-- office, with the same typed confirmation, under the same lockdown state
-- row, with no shift. `started_from` says where it came from: `gate` (a
-- guard's, with the shift that started it, as every lockdown so far) or
-- `office` (the management's, with none). The move-forward trigger is
-- recreated so the shift compares as a value that may be NULL, and where it
-- came from never changes.
-- No row changes: every lockdown so far is a guard's, the default.
-- ============================================================================

ALTER TABLE "gate_lockdowns" ALTER COLUMN "started_shift_id" DROP NOT NULL;
ALTER TABLE "gate_lockdowns" ADD COLUMN "started_from" TEXT NOT NULL DEFAULT 'gate';
ALTER TABLE "gate_lockdowns" ADD CONSTRAINT "gate_lockdowns_started_from"
  CHECK (("started_from" = 'gate' AND "started_shift_id" IS NOT NULL)
      OR ("started_from" = 'office' AND "started_shift_id" IS NULL));

-- As 20261031090300, with the shift compared as a value that may be NULL
-- and where it came from kept.
CREATE OR REPLACE FUNCTION gate_lockdown_moves_forward() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."gate_id" IS NOT DISTINCT FROM OLD."gate_id"
     AND NEW."reason_code" = OLD."reason_code"
     AND NEW."started_by_account_id" = OLD."started_by_account_id"
     AND NEW."started_shift_id" IS NOT DISTINCT FROM OLD."started_shift_id"
     AND NEW."started_from" = OLD."started_from"
     AND NEW."started_at" = OLD."started_at"
     AND OLD."ended_at" IS NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'gate_lockdowns: a lockdown is ended once and never deleted (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
