-- ============================================================================
-- Purchase orders, goods receipts and the three-way match (ADR 0094): a
-- delivery's photo is a file purpose of its own. An enum value alone in its
-- migration (a new value can't be used in the transaction that adds it); the
-- next migrations use it.
-- ============================================================================

ALTER TYPE "file_purpose" ADD VALUE 'goods_receipt_photo';
