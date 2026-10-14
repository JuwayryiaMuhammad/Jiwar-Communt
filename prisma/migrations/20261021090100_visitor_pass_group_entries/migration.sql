-- ============================================================================
-- Gate card, visitors (ADR 0043): a group pass lets in one person per entry.
--
-- A one-time pass for `party_size` people counts its entries: each `in` is
-- one person, under the pass's row lock, and the pass is `used` (its code
-- dead) when the count reaches `party_size`. Until then the same code lets
-- the rest of the group in, at any gate, until `valid_until`. A recurring
-- pass counts nothing: `party_size` caps how many are inside at once.
--
-- Passes used before this let their whole group in on one entry: they
-- count as full.
-- ============================================================================

ALTER TABLE "visitor_passes" ADD COLUMN "entries_used" INTEGER NOT NULL DEFAULT 0;
UPDATE "visitor_passes" SET "entries_used" = "party_size"
 WHERE "kind" = 'one_time' AND "status" = 'used';

-- Never more entries than people; recurring passes never count.
ALTER TABLE "visitor_passes" ADD CONSTRAINT "visitor_passes_entries_used_range"
  CHECK ("entries_used" BETWEEN 0 AND "party_size"
         AND ("kind" = 'one_time' OR "entries_used" = 0));
-- A one-time pass is used exactly when everyone came in.
ALTER TABLE "visitor_passes" ADD CONSTRAINT "visitor_passes_used_when_full"
  CHECK (("status" = 'used') = ("kind" = 'one_time' AND "entries_used" = "party_size"));
