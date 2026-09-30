# 0021 — Unit states, member permissions, minors coming of age

**Status:** Accepted · Phase 2.2

## Context
Journey 05 describes what happens when the household's structure breaks: the primary dies, a couple separates, the primary changes, the unit changes hands, a minor turns 18. It also describes per-member permissions ("my permissions") and says no revocation is ever silent. ADR 0016 already had a single review flag for a primary who left.

## Review flags (one mechanism, extended)
- The three `units.*household_review*` columns became **`unit_review_flags`**:
  - one row per reason; one open row per (unit, reason) by partial unique index;
  - cleared rows stay as history, and nothing is deleted;
  - existing flags were backfilled;
  - reasons are `primary_left`, `primary_frozen` (ADR 0023), `primary_deceased` and `separation`, and several can be open at once;
  - `unitsNeedingReview` pages open flags.
- **`primary_left` needs a decision.** Clearing it by hand is `REVIEW_NEEDS_DECISION`. It is resolved by one of two:
  - `setPrimary`: the family stays;
  - `endHousehold(unitId, reason)` (`residents.manage`): every membership, pending invite, delegation and worker engagement of the unit ends. Each person is told, `settle_before_close` is recorded where a code was issued, and the flags close.
- **`transferOwnership`** ends every active occupancy of the unit (`ownership_transferred`, each occupant told), always runs `endHousehold`, and starts the new owner's occupancy (primary if they live there). The old family never keeps entry or visitor rights to a unit that is no longer theirs. *This amends ADR 0016*: memberships stay when the primary leaves and the family stays (death, separation, a departure), but end when the unit changes hands.
- **Death** (`markPrimaryDeceased`, `residents.manage`, reason code + note):
  - nothing is closed or revoked;
  - every household grant and revocation is refused for everyone, managers included (`HOUSEHOLD_UNDER_REVIEW`), until `setPrimary` or `clearReviewFlag`;
  - capabilities stop everything financial, while tickets, visitors and emergency continue;
  - the adults are told the unit is under review, never why (the note is manager-only and never audited).
- **Separation** (`tagSeparation`):
  - removing an adult or revoking an adult's permission is a manager decision (`SEPARATION_MANAGER_DECISION`); managers use `removeMemberByManagement` / `revokeByManagement` with the new permission **`household.override`**;
  - "my activity" is off; visitor notices still reach everyone;
  - the adults are told.
- **Change of primary:**
  - members are told and keep their permissions;
  - `membersToReview` lists members whose `permissions_reviewed_at` predates the new `primary_since`, and `markMembersReviewed` confirms them ("review now / later");
  - actor ids never move (audit rows are immutable, `added_by` stays);
  - the old primary's delegations end (`primary_changed`), as before.

## Member permissions
- **Delegation and member permissions are separate concepts that never refer to each other.** Delegation (ADR 0016) is an adult *administering* the household for the primary. Member permissions are what each member may *use*.
- **Table `household_member_grants`:**
  - permissions: `visitors_invite`, `bookings`, `tickets`, `finance` (with `cap_per_operation`), `unit_security`;
  - revoked, never deleted; one live grant per (member, permission);
  - adults join with visitors, bookings and tickets, and existing adults were backfilled.
- **A minor can never hold finance, enforced by the database.** The grant carries `member_is_minor` through a composite FK `ON UPDATE CASCADE` plus a CHECK, so turning a member with a finance grant into a minor fails too.
- **Who grants:** the primary or a `household` delegate. Finance is the primary's alone, because money is never delegable. A member without an account (a minor) holds nothing.
- **Revocation** (`revoke`, `revokeAll`) needs a reason code and text, and the member is always told. The baseline is never stored and so never revoked.
- **`assertAllowed(tx, account, unit, permission, { amount })`** is for later domains: `MEMBER_PERMISSION_MISSING`, `FINANCE_CAP_EXCEEDED`, and finance paused under a death review.
- **A revocation mid-action:** the domain saves the input with `submitDeferredAction` (`household_deferred_actions`), and the primary is told and approves or declines. A decline needs a reason and the member is told. Carrying out an approved action belongs to the domain.

## A minor turning 18
- **Never raised automatically.** The in-app sweep (below) tells the primary once, on the birthday in `tenant_settings.timezone` (`majority_notified_at`). The minor has no account, so their notice is recorded as undeliverable.
- **`minorsReadyToConfirm`** gives the primary a read-time "ready to confirm" list.
- **The primary alone confirms** (`inviteMemberToAdulthood`; a delegate cannot):
  - the invite carries `member_id` and the member's document, and takes no extra place in the household;
  - acceptance turns the **same member row** into an adult with an account and the default permissions, so earlier history keeps pointing at it (`household.member_came_of_age`).

## The in-app sweep
- `core/sweep/SweepRunner` is one poller for work that falls due at a time: majority notices, registration expiry (ADR 0024), overdue erasures (ADR 0023).
- Domains register tasks, so core imports none.
- Each task is idempotent and claims its rows with `UPDATE … WHERE <not done> RETURNING`, so it is safe on several instances.
- Tasks walk compounds with `runInTenantUnsafe`; the files are named in `eslint.config.mjs`.
- `SWEEP_ENABLED` and `SWEEP_INTERVAL_MS` (hourly). Tests call `run(name, now)`.

## Notices with nobody to receive them
`Outbox.recordUndeliverable` writes an already-dead, stripped row (`NO_RECIPIENT`), used for minors, unheld permissions and erased accounts. `outbox_messages.recipient_account_id` says which account a message was for. The audit entry of the action says `noticeUndeliverable`.

## Audit
- Unit review: `unit.household_review_flagged` (every reason), `unit.household_review_cleared`, `unit.household_ended`, `unit.ownership_transferred`.
- Household: `household.permissions_reviewed`, `household.permission_granted`, `household.permission_revoked`, `household.deferred_action_submitted`, `household.deferred_action_decided`, `household.member_majority_reached` (system), `household.member_came_of_age` (system).
- Workers: `worker.wage_obligation_recorded`.
