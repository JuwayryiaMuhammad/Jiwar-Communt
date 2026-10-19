-- ============================================================================
-- The management's gate log search (ADR 0056): a visitor found by their
-- full name, exactly, never by a part of it or a likeness. The name's key is
-- the name tidied the one way the code tidies it (src/core/common/
-- visitor-name.ts, nameKey; a unit spec keeps the two in step):
--
-- - Latin capitals lowered, A to Z only (never by the database's locale);
-- - the Arabic letters folded as a plate's are (أ إ آ to ا, ى to ي, ة to ه);
-- - the short vowels and shadda (U+064B to U+0652) and the tatweel (U+0640)
--   removed;
-- - runs of spaces, tabs and line ends made one space, the ends trimmed.
--
-- Generated from `full_name`, so it goes when the name goes: 30 days after
-- the pass or the request (ADR 0028). Nothing else holds it.
-- ============================================================================

ALTER TABLE "visitor_details" ADD COLUMN "name_key" TEXT
  GENERATED ALWAYS AS (btrim(regexp_replace(translate("full_name", 'ABCDEFGHIJKLMNOPQRSTUVWXYZأإآىةًٌٍَُِّْـ', 'abcdefghijklmnopqrstuvwxyzااايه'), '[ \t\r\n]+', ' ', 'g'))) STORED;
CREATE INDEX "visitor_details_name_key_idx"
  ON "visitor_details"("tenant_id", "name_key") WHERE "name_key" IS NOT NULL;
