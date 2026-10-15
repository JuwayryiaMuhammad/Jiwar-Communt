# Architecture Decision Records

| # | Decision | Status |
|---|----------|--------|
| [0001](0001-tenancy.md) | Tenant = compound; authorization layers | Accepted |
| [0002](0002-identity-and-accounts.md) | Separate accounts per capacity; identifiers are not identity | Accepted |
| [0003](0003-account-creation.md) | Accounts are created by an authorized actor inside the tenant | Accepted |
| [0004](0004-login.md) | Login by email or phone, OTP by email | Accepted |
| [0005](0005-rls-mechanics.md) | Postgres RLS with transaction-local tenant setting | Accepted |
| [0006](0006-client-generated-ids.md) | Client-generated UUIDv7 IDs | Accepted |
| [0007](0007-offline.md) | Offline: shared mechanics, domain-owned conflict rules | Accepted (not implemented) |
| [0008](0008-numbering.md) | Numbering: server sequences + reserved ranges | Accepted (not implemented) |
| [0009](0009-open-questions.md) | Open questions | Open |
| [0010](0010-permissions-and-roles.md) | Per-tenant roles, code-defined permissions, sync | Accepted |
| [0011](0011-platform-super-admin.md) | Platform super admin outside the tenants | Accepted |
| [0012](0012-residents-and-occupancy.md) | Residents, multi-unit occupancy, resource access | Accepted |
| [0013](0013-i18n.md) | Codes not text; Arabic and English | Accepted |
| [0014](0014-audit-log.md) | Immutable audit log and security events | Accepted |
| [0015](0015-domain-structure.md) | Domain folders (`core` + domains) and import boundaries | Accepted |
| [0016](0016-household-and-delegation.md) | Primary resident, household, invites and delegation | Accepted |
| [0017](0017-domestic-workers.md) | Domestic workers: engagements, codes, notices, ban | Accepted |
| [0018](0018-identity-documents.md) | Identity documents: national ID or passport, stored birth date | Accepted |
| [0019](0019-email-outbox.md) | Transactional email outbox, at least once | Accepted |
| [0020](0020-occupancy-capacities.md) | Occupancy capacities and `capabilitiesFor` | Accepted |
| [0021](0021-unit-states-and-member-permissions.md) | Unit review flags, member permissions, minors coming of age, the sweep | Accepted |
| [0022](0022-worker-compliance-and-card-incidents.md) | Worker compliance cases, wage obligations, card incidents | Accepted |
| [0023](0023-frozen-accounts-and-erasure.md) | Frozen accounts ("not me") and account erasure | Accepted |
| [0024](0024-self-registration.md) | Resident self-registration: a request first | Accepted |
| [0025](0025-http-api-v0.md) | HTTP API v0: a draft over the services | Accepted |
| [0026](0026-ci.md) | Continuous integration on real Postgres, Redis and Mailpit | Accepted |
| [0027](0027-notifications-inbox.md) | The notifications inbox: a catalog, rows in the action's transaction | Accepted |
| [0028](0028-gate-domain.md) | The gate: shifts, passes, approvals, entries, idempotency | Accepted |
| [0029](0029-object-storage.md) | Object storage: a private bucket (R2, MinIO), presigned uploads checked at finalize | Accepted |
| [0030](0030-qr-entry.md) | QR entry: one token per pass and engagement, derived codes, the visitor's link, the card | Accepted |
| [0031](0031-resident-entry-qr.md) | The resident's entry QR: derived secrets, 30-second steps, no movement log, the photo | Accepted |
| [0032](0032-maintenance-tickets.md) | Maintenance tickets: statuses, history, manual dispatch, confirmation and reopen, messages, visibility | Accepted |
| [0033](0033-dispatch-engine.md) | The dispatch engine: specialties, availability, weighted workload, candidate rules, serialization, triggers, no-candidate handling, the role hook | Accepted |
| [0034](0034-visits-and-sla.md) | Visits and the SLA: windows, absence-entry consent, the receiver, event-sourced clocks, the lock order | Accepted |
| [0035](0035-parcels.md) | Parcels: received at the gate, told to the unit, handed over against a derived code, a resident QR or a delegate | Accepted |
| [0036](0036-preferences-consents-export-deletion.md) | Preferences, consents, data export and account deletion | Accepted |
| [0037](0037-resident-account-gaps.md) | The resident's unit and worker screens: the unit card, a worker's wage and its recorded payments, one of the unit's workers | Accepted |
| [0038](0038-resident-ticket-gaps.md) | The resident's ticket screens: arrival confirmation, the technician on the way, visit slots, two ratings, where in the unit, overdue and escalation, preventive maintenance | Accepted |
| [0039](0039-management-requests.md) | Talking to management: requests and their conversation, cycles and escalation, appointments with slot capacity, ratings, and one list of everything a resident asked for | Accepted |
| [0040](0040-community-engagement.md) | Community life: announcements with audiences read at read time, works and closures, events with a capacity that holds, consultative polls with a ballot secret against the database, suggestions and their public board, the daily brief | Accepted |
| [0041](0041-push-notifications.md) | Push notifications: device tokens, the push outbox, FCM | Accepted |
| [0042](0042-neighbours.md) | Neighbours: complaints against a unit with three private threads and one notice to the unit, lost and found with claims and the handover, the lending board, masked contact with blocks and reported cases, and the welcome | Accepted |
| [0043](0043-gate-card-visitors.md) | The gate card's visitors: a pass read again (derived tokens), group passes one person per entry, standing instructions, the guard's photo and the gate's phone | Accepted |
| [0044](0044-facilities-and-bookings.md) | Facilities and bookings: bookable and walk-in facilities, slots with a capacity that holds, quotas over any 7 days, approvals, closures, no-shows and suspensions, and the club's memberships paid at the office | Accepted |
| [0045](0045-vehicles-and-parking.md) | Vehicles and parking: a unit's vehicles with stickers and permits, the guard's plate lookup, slots and visitor parking with a capacity that holds, fines with one appeal and payments at the office, and parking reports whose reporter the reported unit never learns | Accepted |
| [0046](0046-finance-invoices-and-payments.md) | Finance: a unit's invoices, recurring billing and credit notes, payments at the office and online through each compound's own Paymob account, allocation as append-only rows, and receipts anyone can verify | Accepted |
| [0047](0047-emergencies-and-gate-services.md) | Emergencies and gate services: a critical alarm to every guard on shift with escalation to the management, the family told and on its way, the gate's phone instead of anyone's own, and one table of what residents ask security for | Accepted |
| [0048](0048-finance-instalments-disputes-refunds-ledger-reports.md) | Finance part 2: instalment plans, invoice disputes, refunds of unit credit, allocation release, a computed ledger and four reports with CSV export | Accepted |
