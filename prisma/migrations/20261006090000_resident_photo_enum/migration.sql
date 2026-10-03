-- A resident's own photo (ADR 0031). Its own migration: a new enum value
-- cannot be used in the transaction that adds it (the CHECK comes next).
ALTER TYPE "file_purpose" ADD VALUE 'resident_photo';
