# 0023 — Frozen accounts ("not me") and account erasure

**Status:** Accepted · Phase 2.2

## Frozen accounts
- **Context.** Journey 05: when a phone number passes to someone else and the new holder is shown the old account, "not me" freezes it at once, and it is never reopened for the new holder. With OTP by email (ADR 0004), the new holder of a number can never reach the old account: the code goes to the old owner's email. 05's screen ("this number is registered to [first name]") would also show a name before login, against the enumeration rule. So the **entry now is the manager, on report**, and the self-service "not me" waits for an SMS channel (ADR 0009).
- **`AccountWriter.freeze(tx, account, reason)`** does, in one transaction:
  - status `frozen`;
  - **the phone comes off the account itself** (`accounts.phone` NULL, allowed only while frozen), not only off login, so later domains (gate calls, SMS) can never reach the stranger;
  - the phone identifier is deleted and the email identifier mirrors `frozen`;
  - every session and pending code dies;
  - `account_freezes` keeps the released number's HMAC;
  - the holder is told;
  - the domains react through `AccountLifecycle.onFrozen`: a frozen primary stays primary, each of their units goes under review (`primary_frozen`), delegations continue, and a frozen member's primaries are told.
  - Security event `account.phone_reassigned`, recorded after commit.
- **Never reopened for the new holder:**
  - `updateContact` refuses any number released from that account, forever (`PHONE_RELEASED`);
  - `reactivate` needs a new phone first (`ACCOUNT_PHONE_MUST_CHANGE`);
  - `setStatus(active)` cannot reopen a frozen account (`ACCOUNT_FROZEN`).
- **Recovery** (`accounts.manage`): `AccountsService.updateContact` with a new phone, then `reactivate`, which clears `primary_frozen`.
- "That wasn't me" on an unrecognized login (02) is a different thing and stays `revokeAllMySessions`.

## Account deletion
- **The holder asks** with a confirmation word (`حذف` / `DELETE`) and can undo until `DELETION_GRACE_DAYS` (30) pass. The account stays usable meanwhile.
- **Staff with `accounts.erase` erase in 09's three steps:**
  1. `erasureScope`: what goes, what stays, and a phrase to type;
  2. `activeHolds`;
  3. `erase(typed scope)`.
  - It is refused before the grace ends, under a **legal hold** (`accounts.legal_hold`; place and release with reasons; the person learns it is on hold, never why), or on a wrong phrase.
  - The account row is locked first, and placing a hold takes the same lock, so they never cross.
  - No scheduler erases by itself. `pendingErasures` shows each request's age, and the sweep tells the erasure holders once when a request is `ERASURE_OVERDUE_DAYS` (7) past its grace.
- **A tombstone, not a deletion.** 09 says an account with activity is never deleted; 02 and 09 say personal data is erased. Both hold:
  - the row stays with status `erased` and every personal field NULL (CHECK `accounts_erased_shape`, which also allows only a frozen account to lack its phone);
  - login identifiers and sessions (IP, user agent) are deleted;
  - pending mail to the account is stripped by `recipient_account_id`;
  - invites that brought them in are stripped (`stripped_at`);
  - a last "your account was erased" email is queued before the address goes, and normal retention deletes it once sent.
- **The domains** (`AccountLifecycle.onErasing`):
  - occupancies end (`account_erased`); a primary's unit goes under review, with **no hand-over required first**;
  - memberships end;
  - the workers they registered end with a notice and `settle_before_close`;
  - delegations end.

## Update (Phase 4.3, ADR 0031)
- Freeze, deactivation and erasure revoke the account's **entry credentials** (the resident's rotating QR) in the same transaction (`onFrozen`, `onDeactivated`, `onErasing`).
- An erased account keeps **no photo**: the pointer is cleared and the file deleted in the erasure's transaction (`accounts_erased_shape` also requires `photo_file_id` to be NULL).

## Update (Phase 5.1, ADR 0032)
- Erasure nulls the person's **ticket messages** (body NULL, `deleted_at` set) and their **confirmation comments**; the sender and author stay pointers to the tombstone. Their tickets, descriptions and photos stay: the ticket is the unit's maintenance record.
- A technician who is deactivated, frozen or erased has their tickets in hand released to the dispatch queue in the same transaction.

## Audit
- `account.frozen` (phone as `{ changed: true }`), `account.reactivated`, `account.deletion_requested`, `account.deletion_cancelled`, `account.legal_hold_placed`, `account.legal_hold_released`.
- `account.erased`: every personal field as `{ changed: true }`, counts only.
- `account.erasure_overdue` (system).
- The audit log is never touched by an erasure (ADR 0014 update).
