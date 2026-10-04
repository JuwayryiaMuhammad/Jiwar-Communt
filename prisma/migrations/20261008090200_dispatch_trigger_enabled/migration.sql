-- Phase 5.2 (ADR 0033): turning automatic dispatch on starts a bounded pass
-- over the queue, so enabling has an effect at once instead of at the next
-- sweep. Its attempts are recorded with this trigger. A new value of the
-- 5.2 enum; no 5.1 table or enum changes.
ALTER TYPE "dispatch_trigger" ADD VALUE 'enabled';
