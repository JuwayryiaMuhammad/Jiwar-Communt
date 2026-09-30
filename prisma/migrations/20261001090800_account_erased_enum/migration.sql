-- An erased account (ADR 0023): a tombstone. Its own migration, like
-- 'frozen': the new value is used by the CHECKs of the next one.
ALTER TYPE "account_status" ADD VALUE 'erased';
