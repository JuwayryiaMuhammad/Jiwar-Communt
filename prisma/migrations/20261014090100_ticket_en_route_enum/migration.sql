-- "Technician on the way" (ADR 0038): between assigned and in_progress.
-- Its own migration: a new enum value cannot be used in the transaction
-- that adds it (the technician CHECK comes next).
ALTER TYPE "ticket_status" ADD VALUE 'en_route' AFTER 'assigned';
