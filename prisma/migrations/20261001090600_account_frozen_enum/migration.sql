-- A frozen account (ADR 0023). Its own migration: a new enum value cannot
-- be used in the transaction that adds it (the CHECK comes next).
ALTER TYPE "account_status" ADD VALUE 'frozen';
