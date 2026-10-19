# 0007 — Offline (documented, not implemented)

**Status:** Accepted · implemented for the gate by [ADR 0057](0057-guard-offline.md); elsewhere deferred

- The shared layer will provide **mechanics only**: operation id, device id, client timestamp, idempotency record, retry state, sync metadata.
- **Each domain owns its conflict resolution.** From the journey documents:
  - guard / technician / handover: oldest wins, the later one is flagged "needs review";
  - collection: both accepted, then reconciliation (credit note for a duplicate);
  - unit reservation: first completed wins;
  - ledger entries, votes, permission grants and approvals: never offline.

**The gate (ADR 0057).** The mechanics are the gate's own rather than a shared layer:

- an enrolled device's key signs every call;
- the client id is the action's and the entry's id;
- a per-device sequence replaces a retry state;
- the batch, action and flag rows are the sync metadata.

The guard's rule is refined. **What happened at the gate is never refused:** both actions are recorded at their device time, and what conflicts is flagged for review. "Oldest wins" still holds where a counter would overflow: a once-only pass counts its first entries, and the later ones are flagged.
