-- ============================================================================
-- Cash flow and liquidity (ADR 0091).
--
-- The forecast is computed when asked, never stored: the opening position is
-- the bank and cash accounts' balances (ADR 0085), the outflows what
-- payables already schedules (ADR 0077, 0089), the inflows the residents'
-- dues by their due day at the compound's collection rate of the last 90
-- days. What a compound keeps is its floor and the state of its notice:
--
-- - `cash_minimum`: the least cash the compound wants to hold. The forecast
--   flags a period that closes below it, the dashboard raises it, and the
--   sweep `finance.cash_flow` tells the `finance.cashflow` holders once a
--   dip. Null: no floor, no notice (the default).
-- - `cash_low_since`: when the current dip began (the sweep's, under the
--   row's lock); null while the cash and the forecast stay above the floor.
-- - `cash_low_told_at`: when the holders were last told: once a dip, and a
--   new dip within a day of the last notice is told when the day is up.
--
-- A dip needs a floor: turning the floor off ends a dip in course (a CHECK).
-- Every compound already has its finance_settings row (20261024090100); the
-- columns are added empty, so an existing compound starts with no floor.
-- ============================================================================

ALTER TABLE "finance_settings" ADD COLUMN "cash_minimum" DECIMAL(14,2);
ALTER TABLE "finance_settings" ADD COLUMN "cash_low_since" TIMESTAMPTZ(3);
ALTER TABLE "finance_settings" ADD COLUMN "cash_low_told_at" TIMESTAMPTZ(3);

ALTER TABLE "finance_settings" ADD CONSTRAINT "finance_settings_cash_minimum"
  CHECK ("cash_minimum" IS NULL OR "cash_minimum" > 0);
ALTER TABLE "finance_settings" ADD CONSTRAINT "finance_settings_cash_low_shape"
  CHECK ("cash_low_since" IS NULL OR "cash_minimum" IS NOT NULL);
