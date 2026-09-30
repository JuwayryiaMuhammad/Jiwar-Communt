# 0022 — Worker compliance cases, wage obligations, card incidents

**Status:** Accepted · Phase 2.2 (community side; payroll, the gate and the worker's page come later)

## Context
Journey 11 says a worker found to be under 18 after registration is stopped at once, reported to the compliance officer (not left to the resident), paid in full, and documented in a compliance record. A lost card is replaced free; a confiscation is reported to management and security, never to the resident, who may be the one who took it. ADR 0017 already suspends underage workers.

## Decisions
- **Compliance role:** permission **`workers.compliance`**, held by the manager role by default. A dedicated compliance role can take it later.
- **`worker_compliance_cases`:**
  - kind `underage`, status `open | closed`, source `review | birth_date_correction | report`;
  - one open case per (worker, kind);
  - closing needs a reason code and text, and the case stays on record.
- **Every underage path** (review, a corrected passport date, and the new `reportUnderage(workerId, reason)`):
  - suspends every active code by management;
  - opens (or keeps) the case;
  - records `pay_in_full` for every engagement that ever had a code;
  - emails every `workers.compliance` holder with a case reference and no worker personal data (undeliverable if nobody holds it).
- **Resuming** is refused while an underage case is open (`WORKER_COMPLIANCE_HOLD`). This covers a report that contradicts an adult document; `WORKER_UNDERAGE` still wins when the stored date is under 18.
- **`worker_wage_obligations`:**
  - kinds `pay_in_full | settle_before_close`, one open per (engagement, kind);
  - `settled_at/by` are for payroll to fill;
  - `settle_before_close` is recorded whenever an engagement that had a code closes (end, expiry, household end, erasure of the requester): the worker's file is not closed before the wage is settled.
- **Card incidents:** permission **`workers.incidents`** (managers now; the guard role with the gate). `worker_card_incidents` records type `lost | confiscated`, `reported_via manager | resident`, note and status.
  - `reportCardIncident(engagement, type, note)` files the incident and reissues the code **in the same transaction**, so the old code is dead at commit. The replacement is free: no fee exists anywhere, and finance must never charge for it.
  - A confiscation emails the `workers.incidents` holders.
  - The requester and the primary get "a new code was issued", with neither type nor note.
  - A resident's `reissueCode(engagement, reasonCode)` takes `lost | compromised | other`; only `lost` files an incident.
  - A resident can never file `confiscated`: the service has no such path, and a CHECK refuses it.
  - Residents have no read of incidents.

## Audit
`worker.compliance_case_opened`, `worker.compliance_case_closed`, `worker.card_incident_reported`, `worker.card_incident_closed`, `worker.wage_obligation_recorded`. `worker.code_reissued` records `reasonCode` and `incidentId`. Notes and texts never enter the trail.
