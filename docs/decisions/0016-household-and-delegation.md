# 0016 — Primary resident, household, invites and delegation

**Status:** Accepted · Phase 2

## Context
A unit is lived in by more people than its occupants: spouses, children, parents. The journeys need them in the system (their own login for adults, no account for children), managed by the unit's main resident, with a way to hand part of that work to another adult for a while. The same journeys insist that nothing about a person's status changes silently.

## Decisions

### Primary resident
- Each unit has at most one **primary resident** among its active occupancies (`unit_occupancies.is_primary`, partial unique index).
- The first active occupant of a unit becomes primary automatically. Occupancy changes lock the unit row (`SELECT … FOR UPDATE`, `community/units/unit-lock.ts`), so concurrent first occupants still produce exactly one primary.
- The manager changes it with `setPrimary` (`residents.manage`; audit `occupancy.primary_changed`).
- When the primary's occupancy ends:
  - the unit is flagged `needs_household_review` (reason `primary_left`; audit `unit.household_review_flagged`);
  - **nobody is promoted, and household memberships are not touched**;
  - setting a new primary clears the flag.

### Household
- **Adults join by invite only, with an email.** They get a `family` account (default role `family_member`: `units.read`, `household.manage`, `workers.manage`).
- **Minors are added directly and have no account.** Their name and national ID live on the membership; adults' personal data lives on their account only (a `CHECK` enforces both shapes).
- **Age comes from the Egyptian national ID** (`core/common/egyptian-national-id.ts`, in Egypt's calendar date). Inviting a minor is `INVITE_MINOR_NOT_ALLOWED`; adding an adult as a minor is `MEMBER_NOT_MINOR`.
- **Who may act:** only the unit's primary resident, or a live delegate with the `household` scope, may invite, add a minor, remove a member or revoke an invite (`HouseholdAuthority`, on top of `household.manage`). Anyone else gets `NOT_PRIMARY_RESIDENT`; someone who cannot see the unit gets `UNIT_NOT_FOUND`.
- **Size limit:** active members + pending members + pending unexpired invites stay below `tenant_settings.max_household_members` (`HOUSEHOLD_LIMIT_REACHED`), counted under the unit lock. Occupants are not counted.
- **Settings:** each compound has one `tenant_settings` row, created with the compound and backfilled by migration (`family_join_requires_approval`, `max_household_members`). Managers change it with `settings.manage`, audited as `tenant.settings_changed`.

### Invites
- **The token** is 32 random bytes, shown once to the inviter, who shares the link. Only `HMAC(pepper, "invite:<token>")` is stored: on the invite, and in the global `invite_tokens` row that resolves the link to its compound before anyone is logged in. That row is the same pattern as `login_identifiers`, has no PII, is on the RLS allowlist, and is deleted on acceptance or revocation.
- **Invites expire after 7 days.** An expired invite reads as expired; the first write that touches it persists `expired`, and that write commits.
- **Acceptance** (`InviteAcceptanceService`, the one file in `src/community/` allowed to use `runInTenantUnsafe`):
  1. `startAcceptance(token)` is rate-limited per IP and per token. It sends an **invite-purpose** OTP to the invited email and nowhere else, off the request path, and always gives the same answer. A bad token is recorded as `invite.token_invalid`.
  2. `completeAcceptance(token, code)` runs as `system` in one transaction:
     - it reuses a `family` account of that compound with the same email (the OTP proved ownership, and an inactive one is reactivated) or creates one;
     - it creates the membership: `active`, or `pending_approval` when the compound requires approval (`household.approve`);
     - it marks the invite accepted and deletes the token row;
     - it writes `household.invite_accepted` with `invitedBy`.
  3. The member then logs in through the normal OTP login.
- **OTP challenges carry a purpose** (`login` | `invite_accept`). A code of one purpose can never be consumed for the other, and requesting one never invalidates the other.

### Removal
- A reason is required (`REASON_REQUIRED`). It is stored on the membership, **not copied into the audit trail**, because free text may name people.
- An account left with no other active membership is deactivated through `AccountWriter.setStatus`, which ends its sessions.
- **Never silent:** after commit, the person is emailed in their `preferred_locale`, with the reason. This covers removal by the household and rejection by management. Minors have no account and get no email.
- **Family accounts** see only units where they have an **active** membership (`ResourceAccess`). Pending and removed members see nothing.

### Delegation
- Only the primary creates or revokes a delegation (`household.delegate`). A delegate asking gets `DELEGATION_NOT_ALLOWED`.
- **The delegate** must be an active, adult (by the account's national ID), account-holding member of that unit; otherwise `DELEGATE_NOT_ELIGIBLE`.
- **Scopes** are a non-empty subset of `household` | `workers`. **Money, contracts, governance and ownership are never delegable, now or later**; a unit test pins the enum.
- **Time limit:** `expires_at` is required, in the future, and at most a year away. A DB `CHECK` enforces the year too. There is no permanent delegation.
- At most one live delegation per unit and delegate. An expired one is closed (`expired`) when a new one is created.
- **Expiry is checked at use time** (`DELEGATION_EXPIRED`). No job ends delegations on their date.
- **What a delegate may do:**
  - every action records `metadata.onBehalfOf = <primary>`;
  - a `household` delegate never removes themselves or the primary;
  - a `workers` delegate cannot touch the household.
- **Automatic ends**, recorded in `end_reason`: the delegate's membership removed, the primary changed or left, or either account deactivated. The last one uses the core `AccountLifecycle` hook (ADR 0015).
- **Never silent:** both sides are emailed on create, revoke and every automatic end. Audit actions: `household.delegation_created`, `household.delegation_revoked`, `household.delegation_ended`.

## Known limits
- **Emails are sent after commit, best effort.** A failure is logged, and the action stands. There is no outbox yet; one belongs with the notification channels (ADR 0009).
- A worker's or member's name typed by one household is the name every household sees; there is no per-household alias.

## Update (Phase 2.1)
- **Emails go through the outbox** (ADR 0019): queued in the transaction of the removal, rejection or delegation change, and retried until delivered. This closes the "best effort" limit above.
- **A rejected join request has its own email** ("your request was not approved", with the reason). The person was never a member, so it is no longer the removal email.
- **Units needing review:** `units.household_review_flagged_at` is set with the flag. `ResidentsService.unitsNeedingReview` lists flagged units for managers (`residents.read`): reason, flag time, active occupant count, keyset-paged on (flagged_at, id). Setting a primary removes a unit from the list.
- **Passports:** household members and invitees may hold a passport (ADR 0018). Adulthood and delegate eligibility use the stored birth date.

## Update (Phase 2.2)
- **When the unit changes hands, the household ends** (ADR 0021): a `primary_left` flag is resolved either by `setPrimary` (the family stays) or by `endHousehold`, which ends every membership, invite, delegation and worker engagement with a notice to each person. `transferOwnership` always runs it. Keeping memberships when the primary leaves is still right for death, separation or a departure.
- **The review flag** moved to `unit_review_flags`, which is several reasons, with history (ADR 0021).
- **Minors are never skipped silently:** removing one records an undeliverable notice.
- **Reasons:** removal and rejection take `{ code, text }`; the code goes into the audit metadata.
- **Per-member permissions** are a separate concept from delegation (ADR 0021). A `household` delegate may grant daily permissions but never finance.
- Delegation ends also when the household ends (`end_reason = household_ended`).
