-- ============================================================================
-- Emergencies and gate services (ADR 0047): the management's phones.
--
-- A unit's emergency contacts list the community office and the duty
-- manager; a responder who is not at a gate gives the duty phone. Both are
-- the compound's numbers, E.164, set by its managers. Never a person's own.
-- ============================================================================

ALTER TABLE "tenant_settings"
  ADD COLUMN "office_phone" TEXT,
  ADD COLUMN "duty_phone" TEXT;
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_office_phone_e164"
  CHECK ("office_phone" IS NULL OR "office_phone" ~ '^\+[1-9][0-9]{6,14}$');
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_duty_phone_e164"
  CHECK ("duty_phone" IS NULL OR "duty_phone" ~ '^\+[1-9][0-9]{6,14}$');
