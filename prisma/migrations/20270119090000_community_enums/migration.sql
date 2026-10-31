-- ============================================================================
-- Community (ADR 0071): the enum values the phase's tables use, alone in
-- their migration because a new enum value cannot be used in the
-- transaction that adds it.
--
-- `market` is the notification category of the market (listings, shops,
-- group offers), so a resident may mute it. `market_listing_photo` is a
-- listing's photo, the seller's; `gallery_photo` a compound album's photo,
-- uploaded by the staff only.
-- ============================================================================

ALTER TYPE "notification_category" ADD VALUE 'market';
ALTER TYPE "file_purpose" ADD VALUE 'market_listing_photo';
ALTER TYPE "file_purpose" ADD VALUE 'gallery_photo';
