# 0008 — Numbering (documented, not implemented)

**Status:** Accepted · implementation deferred

Two mechanisms:
- **Server sequences**, gapless per scope, for anything numbered online.
- **Reserved ranges per device / custody** for offline receipts, which must carry their final number at the moment of collection.

The finance domain owns the semantics: who reserves, when, and how gaps are audited.
