-- B2 (ADR 0033 update): a dispatcher putting a technician back to work
-- gives no reason; there is nothing to choose between. Taking them off
-- still needs a code, and so does every change of the system's.
--
-- The table is append-only (its triggers stop UPDATE, DELETE and TRUNCATE,
-- not DDL). Every existing row satisfies the stricter old CHECK, so it
-- satisfies this one.
ALTER TABLE "technician_availability_history"
  DROP CONSTRAINT "technician_availability_history_reason_shape";
-- Guarded against the NULL trap: a NULL actor (the system) satisfies
-- neither the first branch nor the third, because both test
-- "changed_by_account_id" IS NOT NULL before anything else. "to_state" and
-- "account_id" are NOT NULL.
ALTER TABLE "technician_availability_history"
  ADD CONSTRAINT "technician_availability_history_reason_shape"
  CHECK (("changed_by_account_id" IS NOT NULL AND "changed_by_account_id" = "account_id")
      OR "reason_code" IS NOT NULL
      OR ("changed_by_account_id" IS NOT NULL AND "to_state" = 'available'));
