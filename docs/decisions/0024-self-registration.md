# 0024 — Resident self-registration

**Status:** Accepted · Phase 2.2 (supersedes ADR 0003's "no self-registration" and closes ADR 0009 #1)

## Context
Journey 02: name + unit number + phone → OTP → the home screen, and the unit stays "under review" until the manager approves. Product decision 5 and ADRs 0003, 0004 and 0018 require an email (OTP always goes by email) and an identity document on every account. A registrant with only a phone could never receive a code.

## Decisions
- **A request first, never an account.** The registrant sends:
  - name, unit code, phone, **email**, **ID document** (plus birth date for a passport);
  - occupancy type and resides;
  - optionally the activation data: unit type, area, building.

  No account or session exists until a manager approves. The only things a pending registrant could use, documents and emergency, are client-side or future; `capabilitiesFor` gives exactly those.
- **The compound comes from a registration link.** Global `registration_links` stores the token HMAC only and sits on the RLS allowlist. The manager creates and revokes links (`residents.manage`); no live link means registration is off.
- **Same body, same status, same work for every input:**
  - `start` validates the shape, applies the OTP limiters (per IP, per email), and issues a code with **purpose `registration`**, off the request path, to the typed email, whatever the link, unit or phone. The code is keyed on the link, the email and a digest of the exact payload, so the payload cannot be swapped at completion.
  - `complete` verifies the code, then makes **one upsert** of the pending request (by email) and one audit entry, and **never reads units, accounts or occupancies**. The enumeration test proves it with a proxy over the transaction.
  - An invalid link writes nothing: the link is published (a QR at the gate), and its validity says nothing about a person or a unit. It is recorded as a background security event (`registration.link_invalid`).
  - 02's "we couldn't find this unit" message is deliberately not given.
- **The manager sees the differences** at read time: `unit_not_found`, `unit_has_primary`, `unit_has_residing_occupants`, `phone_in_use`, `email_in_use`, `same_person_existing_account`, `duplicate_pending_for_unit`.
- **Approval** re-checks under the unit lock:
  - it creates the account (AccountWriter) and the occupancy (the first residing occupant is primary, ADR 0020), or adds the unit to the same person's existing account when asked;
  - `unitId` corrects a mistyped unit;
  - any other clash is `REGISTRATION_CONFLICT` with the list;
  - activation data fills only what the unit does not know.
- **Rejection** tells the registrant the manager's reason text, never the conflict.
- **Personal data lives on the request only while pending** (CHECK `resident_registrations_pii_only_pending`); every decision nulls it. A request nobody decides **expires** after `REGISTRATION_PENDING_DAYS` (30) from the sweep, and the registrant is told.
- **Activation card:** `units.unit_type` and `area_sqm`; `missingActivationSteps` and `submitUnitDetail` (primary) fill only empty fields, one step at a time, and the manager's value wins.
- **03's "request correction"** needs document storage and is left for later (ADR 0009).

## Audit
`registration_link.created`, `registration_link.revoked`, `resident.self_registered` (system), `resident.registration_approved`, `resident.registration_rejected`, `resident.registration_expired` (system), `unit.details_submitted`. Security event `registration.link_invalid`.
