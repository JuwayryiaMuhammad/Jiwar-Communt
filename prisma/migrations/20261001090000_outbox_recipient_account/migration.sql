-- ============================================================================
-- Phase 2.2: the account an outbox message is for (a pointer, no FK — the
-- table is global, ADR 0019). Erasure strips that account's pending
-- messages; an email address alone may be shared by several accounts.
-- ============================================================================
ALTER TABLE "outbox_messages" ADD COLUMN "recipient_account_id" UUID;
CREATE INDEX "outbox_messages_recipient_account_id_idx"
  ON "outbox_messages"("recipient_account_id");
