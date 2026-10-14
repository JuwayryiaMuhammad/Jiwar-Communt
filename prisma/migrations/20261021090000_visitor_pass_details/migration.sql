-- ============================================================================
-- Gate card, visitors (ADR 0043): a pass the host can read again.
--
-- A pass's token is now derived, like a parcel's (ADR 0035):
-- base64url(HMAC(VISITOR_PASS_TOKEN_KEY, "pass:<tenant>:<passId>:<seq>")).
-- `token_seq` is the sequence number of the live token: a new code (a link
-- reissued, a replayed create, a code taken by another pass) is the next
-- number. The server still stores only the code's and the token's HMACs;
-- NULL on passes issued before, whose code cannot be shown again.
--
-- A visitor's vehicle plate lives with the name and the phone, and goes
-- with them (30 days after the pass or the request, ADR 0028).
-- ============================================================================

ALTER TABLE "visitor_passes" ADD COLUMN "token_seq" INTEGER;
ALTER TABLE "visitor_passes" ADD CONSTRAINT "visitor_passes_token_seq_range"
  CHECK ("token_seq" IS NULL OR "token_seq" >= 0);

ALTER TABLE "visitor_details" ADD COLUMN "vehicle_plate" TEXT;
ALTER TABLE "visitor_details" ADD CONSTRAINT "visitor_details_vehicle_plate_length"
  CHECK ("vehicle_plate" IS NULL OR char_length("vehicle_plate") BETWEEN 1 AND 12);
ALTER TABLE "visitor_details" DROP CONSTRAINT "visitor_details_not_empty";
ALTER TABLE "visitor_details" ADD CONSTRAINT "visitor_details_not_empty"
  CHECK ("full_name" IS NOT NULL OR "phone" IS NOT NULL OR "vehicle_plate" IS NOT NULL);
