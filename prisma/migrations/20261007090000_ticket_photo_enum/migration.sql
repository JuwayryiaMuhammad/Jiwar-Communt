-- A ticket's photos (ADR 0032). Its own migration: a new enum value cannot
-- be used in the transaction that adds it (the size CHECK comes next).
ALTER TYPE "file_purpose" ADD VALUE 'ticket_photo';
