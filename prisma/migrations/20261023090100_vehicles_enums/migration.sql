-- ============================================================================
-- Vehicles and parking (ADR 0045): the notification category `vehicles`,
-- and three file purposes: a vehicle's licence (an image or a PDF, the
-- resident's), a resident's parking photo (a report's or an appeal's) and
-- a fine's photo (the staff's). Alone in their migration: a new enum value
-- cannot be used in the transaction that adds it.
-- ============================================================================

ALTER TYPE "notification_category" ADD VALUE 'vehicles';
ALTER TYPE "file_purpose" ADD VALUE 'vehicle_licence';
ALTER TYPE "file_purpose" ADD VALUE 'parking_photo';
ALTER TYPE "file_purpose" ADD VALUE 'vehicle_fine_photo';
