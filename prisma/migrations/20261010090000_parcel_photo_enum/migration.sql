-- A parcel's photos: the one taken at the gate and the one at hand-over
-- (ADR 0035). Its own migration: a new enum value cannot be used in the
-- transaction that adds it (the size CHECK comes next).
ALTER TYPE "file_purpose" ADD VALUE 'parcel_photo';
