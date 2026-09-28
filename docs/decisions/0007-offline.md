# 0007 — Offline (documented, not implemented)

**Status:** Accepted · implementation deferred

- The shared layer will provide **mechanics only**: operation id, device id, client timestamp, idempotency record, retry state, sync metadata.
- **Each domain owns its conflict resolution.** From the journey documents:
  - guard / technician / handover: oldest wins, the later one is flagged "needs review";
  - collection: both accepted, then reconciliation (credit note for a duplicate);
  - unit reservation: first completed wins;
  - ledger entries, votes, permission grants and approvals: never offline.
