-- ============================================================================
-- Visitors (ADR 0071): a household told when its visitor comes and goes.
--
-- `visitor_passes.notify_on_entry`: the pass's host and whoever in the unit
-- is told of its visitors (`visitorsNotify`) hear of each entry and exit on
-- it — the pass and the gate only, never the visitor's name. On by default;
-- off for recurring passes (a cleaner every morning would be noise), which
-- the host may turn on. Existing recurring passes are turned off, compound
-- by compound.
--
-- `unit_standing_instructions.notify`: an opt-in on an instruction; when the
-- guard lets someone in by an `always_allow` instruction carrying it, the
-- household is told (closes ADR 0043's open item).
-- ============================================================================

ALTER TABLE "visitor_passes" ADD COLUMN "notify_on_entry" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "unit_standing_instructions" ADD COLUMN "notify" BOOLEAN NOT NULL DEFAULT false;

DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    UPDATE "visitor_passes" SET "notify_on_entry" = false
     WHERE "tenant_id" = t AND "kind" = 'recurring';
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
