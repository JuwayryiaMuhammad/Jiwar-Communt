-- ============================================================================
-- The market's rules (ADR 0083, amends 0071)
-- ============================================================================
--
-- Three more settings, applied to a new or edited listing (and a new shop)
-- from now on; whatever is open stays:
-- - `commercial_blocked`: no service offered and nothing under a shop;
-- - `blocked_categories`: the categories taken off (the API shows the ones
--   allowed), so a category the market adds later is allowed until taken
--   off; one at least stays allowed;
-- - `max_live_per_unit`: listings one unit may have open at once, whoever
--   of its people posts them, beside the per-account limit.
-- The defaults keep every compound's market as it was.
-- ============================================================================
ALTER TABLE "market_settings"
  ADD COLUMN "commercial_blocked" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "blocked_categories" "market_listing_category"[] NOT NULL DEFAULT '{}',
  ADD COLUMN "max_live_per_unit" INTEGER NOT NULL DEFAULT 10;
ALTER TABLE "market_settings" ADD CONSTRAINT "market_settings_unit_limit"
  CHECK ("max_live_per_unit" BETWEEN 1 AND 50);
ALTER TABLE "market_settings" ADD CONSTRAINT "market_settings_categories"
  CHECK (cardinality("blocked_categories")
         < cardinality(enum_range(NULL::"market_listing_category")));

-- A listing counts against its unit's limit by the unit it was posted from.
CREATE INDEX "market_listings_seller_unit_idx"
  ON "market_listings"("tenant_id", "seller_unit_id", "status");
