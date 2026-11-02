-- ============================================================================
-- Inspection requests whose task went with its guard (ADR 0063, ADR 0050)
-- ============================================================================
--
-- A guard deactivated, or erased, has the tasks still theirs cancelled
-- (`assignee_left`). Until now that skipped what the management's cancel
-- does: the inspection request the task answered stayed `scheduled`, and
-- as a unit holds one live request at most, its owner could not ask again.
-- The code now cancels the request with its task, as the management's
-- cancel does (`task_cancelled`, by whoever cancelled the task: nobody when
-- the guard left). This applies the same rule to the requests already
-- held that way, one compound at a time (FORCE RLS).
--
-- Which rows: a `scheduled` request whose task (the one naming it, at most
-- one) is `cancelled`. Every other cancel already cancelled its request in
-- the same transaction, so these are exactly the requests a guard's going
-- left behind. A request whose task is open, in progress or done is not
-- touched; a second run finds nothing to change.
--
-- The values: cancelled when its task was (never before the request was
-- made), by the task's canceller, with `task_cancelled`. The requests'
-- trigger lets `scheduled` move to `cancelled`, keeping `scheduled_at`.
-- ============================================================================

DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', t."id"::text, true);
    UPDATE "unit_inspection_requests" r
       SET "status" = 'cancelled',
           "cancelled_at" = GREATEST(k."cancelled_at", r."created_at"),
           "cancelled_by" = k."cancelled_by_account_id",
           "cancel_reason" = 'task_cancelled'
      FROM "guard_tasks" k
     WHERE r."tenant_id" = t."id"
       AND k."tenant_id" = r."tenant_id"
       AND k."request_id" = r."id"
       AND k."status" = 'cancelled'
       AND r."status" = 'scheduled';
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
