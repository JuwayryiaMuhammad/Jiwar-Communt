-- ============================================================================
-- Board matters (ADR 0055): the enum values alone. A new enum value cannot
-- be used in the transaction that adds it.
--
-- File purposes:
--   `approval_attachment`      a document or photo of an approval request's
--                              package, the manager's or the accountant's;
--   `board_appeal_attachment`  an owner's document or photo backing an
--                              appeal to the board;
--   `expense_invoice`          an expense's invoice, the accountant's.
-- ============================================================================

ALTER TYPE "file_purpose" ADD VALUE 'approval_attachment';
ALTER TYPE "file_purpose" ADD VALUE 'board_appeal_attachment';
ALTER TYPE "file_purpose" ADD VALUE 'expense_invoice';
