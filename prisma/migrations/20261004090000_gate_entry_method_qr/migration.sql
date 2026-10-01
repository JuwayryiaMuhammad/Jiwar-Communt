-- Phase 4.1 (ADR 0030): an entry let in by a scanned QR. A new enum value
-- cannot be used in the transaction that adds it, so it has its own step.
ALTER TYPE "gate_entry_method" ADD VALUE 'qr';
