-- ============================================================================
-- Phase P1 — partner consents (ADR 0060, amends ADR 0036). One consent per
-- category of service: a request to a partner of that category may show
-- the partner what the one request needs. The catalog (CONSENT_CATALOG in
-- src/core/consents/consent-catalog.ts) and these CHECKs list the same
-- codes; a unit test keeps them in step.
-- ============================================================================

ALTER TABLE "consent_events" DROP CONSTRAINT "consent_events_code_known",
  ADD CONSTRAINT "consent_events_code_known"
  CHECK ("code" IN (
    'ticket_phone_share',
    'partner_share_gas_water',
    'partner_share_pharmacy',
    'partner_share_grocery',
    'partner_share_home_services',
    'partner_share_laundry',
    'partner_share_gardening',
    'partner_share_beauty_at_home',
    'partner_share_repair',
    'partner_share_pets',
    'partner_share_events',
    'partner_share_moving_storage',
    'partner_share_car_services',
    'partner_share_elderly_care'));

ALTER TABLE "account_consents" DROP CONSTRAINT "account_consents_code_known",
  ADD CONSTRAINT "account_consents_code_known"
  CHECK ("code" IN (
    'ticket_phone_share',
    'partner_share_gas_water',
    'partner_share_pharmacy',
    'partner_share_grocery',
    'partner_share_home_services',
    'partner_share_laundry',
    'partner_share_gardening',
    'partner_share_beauty_at_home',
    'partner_share_repair',
    'partner_share_pets',
    'partner_share_events',
    'partner_share_moving_storage',
    'partner_share_car_services',
    'partner_share_elderly_care'));
