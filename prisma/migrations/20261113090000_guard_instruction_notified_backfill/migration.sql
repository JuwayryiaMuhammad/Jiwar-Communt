-- ============================================================================
-- Instructions sent before ADR 0056: their recipients were told when they
-- were sent. 20261104091000_instruction_validity meant to record it
-- (`notified_at`) with a bare UPDATE, but guard_instruction_recipients is
-- under FORCE RLS: run by the migrator with no compound set, the UPDATE saw
-- no row, and every recipient of an earlier instruction kept a null
-- `notified_at`. A guard opening a shift is pushed each live instruction
-- that applies there and has not told them (reachOnStart), so those would
-- be pushed again. That migration is applied and stays as it is; this one
-- records it, one compound at a time.
--
-- Which rows: a null `notified_at` on an instruction with neither
-- `valid_from` nor `valid_until`. Those columns came with ADR 0056, so
-- every earlier instruction has neither. Since ADR 0056, an instruction
-- with neither holds every day, and both ways a recipient is added (at the
-- send, at a shift start) record `notified_at` when it holds: no such row
-- is null. A recipient waiting for a later `valid_from` is untouched.
--
-- The value: the instruction's sent time (`created_at`), or the
-- recipient's own `added_at` when later (one reached at a shift start), so
-- `notified_at` is never earlier than its row. The recipients' trigger
-- lets `notified_at` be written once, from null.
-- ============================================================================

DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', t."id"::text, true);
    UPDATE "guard_instruction_recipients" r
       SET "notified_at" = GREATEST(i."created_at", r."added_at")
      FROM "guard_instructions" i
     WHERE r."tenant_id" = t."id"
       AND i."tenant_id" = r."tenant_id"
       AND i."id" = r."instruction_id"
       AND r."notified_at" IS NULL
       AND i."valid_from" IS NULL
       AND i."valid_until" IS NULL;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
