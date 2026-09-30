-- ============================================================================
-- Phase 2.2 — a minor turning 18 (ADR 0021). Never raised automatically:
-- the sweep tells the primary once (majority_notified_at), and the primary
-- confirms by inviting the member, linked to the SAME member row
-- (household_invites.member_id), so their history stays continuous.
-- ============================================================================
ALTER TABLE "household_members" ADD COLUMN "majority_notified_at" TIMESTAMPTZ(3);
ALTER TABLE "household_invites" ADD COLUMN "member_id" UUID;
ALTER TABLE "household_invites"
  ADD CONSTRAINT "household_invites_tenant_id_member_id_fkey"
  FOREIGN KEY ("tenant_id", "member_id") REFERENCES "household_members"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
