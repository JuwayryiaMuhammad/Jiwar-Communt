# The plan

What landed, the owner's standing decisions, and what is left. It replaces the lost planning notes; the decisions themselves are the ADRs ([index](decisions/README.md)). Updated 2026-11-09, after M3-5.

## Done

| Phase | ADR | What |
| --- | --- | --- |
| 0 | 0001–0006 | Tenancy, accounts, login, RLS, client ids |
| 1a | 0010–0013 | Roles and permissions, the platform admin, residents and occupancy, codes not text |
| 1b | 0014 | The audit log and security events |
| 2, 2.1, 2.2 | 0015–0024 | Domains, households, domestic workers, identity documents, the email outbox, capacities, unit states, compliance, erasure, self-registration |
| 3 | 0025 | HTTP API v0 |
| 4, 4.1–4.3 | 0026–0031 | CI, the notifications inbox, the gate, object storage, QR entry, the resident's QR |
| 5.1–5.3 | 0032–0034 | Maintenance tickets, the dispatch engine, visits and the SLA |
| G1–G8, O1 | 0035, 0043, 0045, 0047, 0049, 0050, 0052, 0053, 0056, 0057, 0068 | The gate card: parcels, visitors, vehicles, emergencies, permits, shifts, patrols, security, completion, offline, vendors behind drivers |
| R1–R11c | 0036–0040, 0042, 0044, 0046, 0048, 0051, 0054, 0055, 0058, 0059, 0062, 0063, 0069–0071 | The resident: preferences and export, units, tickets, requests, community, neighbours, bookings, finance, governance, children, decisions, appeals, the unit on paper, moves, money, extras, community completion |
| P1 | 0041, 0060 | Push notifications, partners |
| CI | 0061 | Migration safety |
| M1-1 to M1-3b | 0064–0067 | Assets and inspections, store and costs, energy, readiness and safety |
| M2-1 to M2-15 | 0072–0084, 0087 | The unit register, dispatch depth, the inbox and the deputy, the operations dashboard, vendors and contracts, compliance, fit-out, announcements, experience, transfers and dues, analytics, spaces, the board's work |
| M2-7 | 0088 | The contractor portal and tenders |
| M2-12a | 0078 | The field team |
| M2-12b | 0090 | The field team, part b |
| M3-1 | 0089 | Payables and commitments |
| M3-2 | 0085 | Treasury and custody |
| M3-3 | 0086 | The reports platform |
| M3-4 | 0091 | Cash flow and liquidity |
| M3-5 | 0092 | The general ledger |

## The owner's standing decisions

- Mobile apps are out of this repo's scope.
- A compound never moves between companies.
- A resident never changes their unit's type or area.
- The ledger was built, double-entry (ADR 0092).

## Left

### Dashboard gaps

Closed in the maintenance phase of 2026-11-09:
- tenders: award, deadline, documents, inviting a vendor, renewing or revoking a bid link (0088);
- the public bid page for a bid link (0088), and a bid's documents through it (the owner's decision of 2026-11-09);
- a staff certificate's paper (0090);
- the journal paged past its first 50 entries (0092).

Still open:
- a vendor's contractors and the dispatch's "offer to a vendor" (0088);
- the reinforcement call's zone, the technicians' locations on a map (0090);
- starting a conversation with a resident (0080);
- the compensation credit's invoice and authorization pickers (0082);
- the ledger: a top-level account, code changes, a year-end entry (0092);
- pickers and counts past the first 100 rows (0072); the rest of `apps/README.md` "Known limits".

### Waiting on the owner

- Arabic for the dashboards: translation and right-to-left. Not started (0013).
- SMS and WhatsApp channels: waiting on the owner's provider (0004, 0009, 0019, 0027, 0080).

### Real device integrations

- Security devices: vendor drivers, face checks, phone-network fallback (0068).
- Smart meters and their feeds (0066).

### Finance deferred

VAT and its declaration (0089, 0092); withholding tax (0089); year-end close (0092); purchase orders with three-way match (0077, 0088, 0089); bank integration (0085); matching online payments to the bank (0085, 0091, 0092); sub-ledgers (0092).

### Each domain's open items

From the ADRs' "Open" sections; the ADR has the detail.

- 0009 — Shorter sessions for sensitive roles; backfill migrations; dead outbox messages unseen; screen details.
- 0010 — Custom roles; per-account permission overrides.
- 0013 — Bilingual names for compounds and units.
- 0014 — Audit hash chaining, blocking owner DDL, retention, read-access logging, export.
- 0016 — No per-household alias for a worker's or member's name.
- 0018 — The national ID's check digit is not validated.
- 0019 — Nobody is shown dead outbox messages.
- 0031 — Photo retention for deactivated accounts; a manager view to revoke a resident's credentials; residents without a smartphone.
- 0035 — A re-key tool for PARCEL_TOKEN_KEY; lockers, courier delivery to the door, bulk receiving, partial handover.
- 0037 — Correcting a wage payment recorded by mistake.
- 0039 — Appointments have no attended or no-show; slot lock rows are never removed.
- 0040 — An event's seat when its holder leaves; a changed event tells nobody.
- 0042 — Notice preview; retired categories; walk-in handover search; complaint assignee.
- 0043 — Group count on an entry; the resident's history of decided gate requests.
- 0044 — Staff booking for a resident; cancellations by erasure tell nobody; slot-length changes.
- 0045 — Lost stickers; Arabic letter variants in plate matching.
- 0047 — A live channel; GPS and maps; the clinic (C5, C6).
- 0049 — No ID override at the gate; workers added after approval.
- 0050 — Task overdue alarms; unacknowledged handovers; payroll or attendance CSV.
- 0051 — Voting owner among co-owners.
- 0052 — A late scan never completes an ended run; no pause on a run.
- 0053 — Residents' vehicles and workers' IDs against the blocklist; match notices deduplicated.
- 0054 — Escort overrides for custody; a child's return not tracked.
- 0055 — Overview figures (collection rate, SLA, facility use); expenses paid through the app.
- 0056 — A management duty roster for field exceptions; offline field exceptions and recordings.
- 0057 — A resident QR with a daily offline MAC; per-device bundle sections; a manager view of offline gaps.
- 0058 — A debtor service-suspension engine; a quote becoming an invoice; formal notices with cure periods.
- 0059 — A worker review after an overturn; an objection that forces a vote.
- 0060 — A partner with many compounds has one desk per compound.
- 0062 — A retention-policy table (periods are fixed in code).
- 0063 — The `requests` delegation scope; moves and proxies send no notifications.
- 0064 — A check-up nudge to households; a closure linked to its work order; drawn signatures.
- 0065 — Costs in the budget and resident invoices; counts by store and store audits.
- 0066 — Meter QR tags; leak rules; bills to residents from meters.
- 0067 — Readiness budgets as board approvals; work on hold at a revocation.
- 0070 — A reversed payment does not undo a club membership; violations not owed through charges.
- 0071 — Weather, vaccination records, loyalty points, walk-in occupancy.
- 0073 — A dispute's inbox row has no amount; inspection campaigns and part requests are not in the inbox.
- 0075 — The monthly report's deadline sweep; action-item owners outside the board.
- 0076 — A per-role escalation matrix; impact score; warranty claims' answer date.
- 0079 — Per-account layouts and wall mode; the brief by email or PDF.
- 0080 — Per-compound letter templates.
- 0081 — Read logs' retention; manual case grouping; a drift alert on service standards.
- 0082 — The rule for logins after a bad event and for SLA breaches; the resident's side of a case.
- 0084 — Holidays for inspections and readiness; a fee on use requests; map positions.
- 0085 — A statement line matched to a payout; cash refunds out of a box; a reconciliation report with the running balance.
- 0086 — A custom report builder; recipients beyond permission holders; capital-plan lines tied to budget lines.
- 0090 — The location consent's text and version; certificates per ticket category.
- 0091 — Forecast against actual; a run rate for unscheduled spending; scenarios.
- 0092 — Budgets against the ledger's expense accounts; cash refunds out of a cash box.
