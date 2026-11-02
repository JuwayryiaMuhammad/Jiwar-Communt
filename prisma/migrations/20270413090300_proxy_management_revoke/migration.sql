-- ============================================================================
-- The management ends an owner's proxy, with a code (ADR 0083, amends 0063)
-- ============================================================================
--
-- A proxy revoked by the management ends as any revoked proxy does
-- (`end_reason` 'revoked', `ended_by` the manager), with the management's
-- code beside it (REASON_CODES.proxyRevokeByManagement). An owner's own
-- revocation has none. The forward-only trigger already lets the end set
-- it (only the appointment's columns are fixed) and refuses any later
-- change: unit_proxies_state_shape is not recreated.
-- ============================================================================
ALTER TABLE "unit_proxies" ADD COLUMN "revoke_code" TEXT;
ALTER TABLE "unit_proxies" ADD CONSTRAINT "unit_proxies_revoke_code"
  CHECK ("revoke_code" IS NULL
     OR ("end_reason" IS NOT NULL AND "end_reason" = 'revoked'
         AND "revoke_code" IN ('misuse', 'owner_request', 'identity_doubt',
           'security_concern', 'other')));
