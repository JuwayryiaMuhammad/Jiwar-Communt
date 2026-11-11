# 0082 — Experience and recovery

**Status:** Accepted · Phase M2-10 · amends ADR 0038 and 0039 (a low rating says why), 0060 (the same on a partner request), 0055 and 0073 (a new approval type, `compensation_above_limit`, binding), 0058 (the compensation credit note now also comes from a case)

## Context

The residents audit (2026-11-01, "تجربة السكان والتعافي") found ten rows partial or missing. Ratings were stored per item: a ticket's confirmation (0038), a management request's (0039), a partner request's (0060). A low rating said nothing about why. Nothing read the ratings, the tickets sent back or the complaints across a unit. There was no follow-up before a resident complained and no recovery after a failure. Promises lived in each domain with no register. A compensation was a credit note anyone with `finance.invoice` could issue, with the board's threshold advisory. The owner approved rule-based signals (no AI), a binding compensation limit with the board above it, and a rule table for recommendations (decisions 10–12).

## Decisions

### 1. A low rating says why

- **One rule for the three ratings** (`src/core/experience/low-ratings.ts`): a rating of 1 or 2 (`LOW_RATING_MAX`) takes `lowReasonCode` from `REASON_CODES.lowRating`:
  - `not_fixed`, `slow`, `poor_quality`, `staff_conduct`, `no_show`, `poor_communication`, `price`, `other`.
  - Optional for now (the owner, 2026-11-04): a low rating without one is taken, until the resident apps ship the picker. Unknown: `INVALID_REASON_CODE`. On 3 to 5: `FIELD_NOT_ALLOWED`.
- **Where:**
  - `POST /tickets/{id}/confirm`: the service's rating, not the technician's;
  - `POST /management-requests/{id}/rating`;
  - `POST /partner-requests/{id}/rating`.
- **Stored** on the rating row (`low_reason_code`), a code and never words. A CHECK holds it to the list and to a low rating. The ratings' immutability triggers cover it.
- **Shown** wherever the rating is shown: the dispatch's feedback, the request ratings, the partner request's rating, and so in the per-account export.
- Ratings given before, and low ones given without a reason, have none. The report counts them as `unstated`.

### 2. Sources, registered in core

`ExperienceSources` (core) holds what the rules read. Core imports no domain (ADR 0015); each domain registers at startup:

- **Ratings** (maintenance, management, partners): the rating, its unit, its low reason and when, in a period.
- **Events:** a ticket rejected or reopened by its reporter (maintenance); a complaint about a partner request (partners) and a complaint a unit made about another (neighbours, the complaining unit only).
- **Measures:** a resident's ticket completed within hours (maintenance); a request's first staff response within hours (management).
- **Units** (community): a unit's code and building, never its people.

A missing source fails the bootstrap.

### 3. Signals: rules, no AI

- **Three rules** in `experience_settings`, per compound. No row means the code's defaults; a count of null turns a rule off.

  | rule | default |
  |---|---|
  | `repeated_low_ratings` | 2 within 90 days |
  | `reopened_tickets` | 2 within 60 days |
  | `repeated_complaints` | 3 within 30 days |

  The counts may be 2 to 20 and the days 7 to 365. `GET`/`PATCH /staff/experience/settings` show and change them, under an advisory lock, audited per rule.
- **The sweep `experience.signals`** runs every 15 minutes. For each rule on, it finds the units with the count of events within the days. A unit's signal is written once per its newest event: the key `(unit, code, basis_id)` with `ON CONFLICT DO NOTHING`, so two runs at once write it once. A unit signals again only when a new event comes.
- **A signal opens or joins a case.** It joins the unit's open case, or opens a follow-up as the system, and tells the holders of `experience.manage` (`experience_case.opened`). Audited as the system's (`experience_signal.raised`).

### 4. Follow-up and recovery cases

- **`experience_cases` (`EC-000123`)** about one unit:
  - a kind: `follow_up` (before they complain) or `recovery` (after a failure);
  - an origin: `signal` or `manual`;
  - optionally what it is about (a ticket, a management request or a partner request) and what failed (the compensation reasons of ADR 0058);
  - a staff note, an owner, and a close with an outcome from `experienceCaseOutcome`, once.
- **One open case per unit.** A partial unique index backs it, and every opening is an `INSERT … ON CONFLICT DO NOTHING` against it:
  - two signals, or a signal and a hand, at once make one case;
  - a hand that meets one is `409 EXPERIENCE_CASE_OPEN` with the open one's `caseId`.
  - A signal that meets a case being closed waits for the close, then opens a new one.
- **The owner** is an active staff or manager account (`409 EXPERIENCE_OWNER_INVALID`) and is told (`experience_case.assigned`).
- **Due times are the staff inbox's** (ADR 0073), two new types:
  - `follow_up_case`, 72 h by default;
  - `recovery_case`, 24 h by default.

  The compound sets its own in the inbox's settings. A case shows its `dueAt`, and the inbox's overdue notice covers it.
- **The close** is refused while one of the case's compensations waits (`409 EXPERIENCE_CASE_COMPENSATION_PENDING`). It is `compensated` only with one approved (`409 EXPERIENCE_CASE_NOT_COMPENSATED`). Closed is final: a trigger holds the row.
- **Routes:** `GET`/`POST /staff/experience/cases`, `GET …/{id}` (with its signals and compensations), `POST …/{id}/assign`, `POST …/{id}/close`, `GET /staff/experience/signals`.

### 5. Compensations: the manager's limit, the board above it

- **Proposed on an open case** (`experience.manage`):
  - what failed, from `creditNoteCompensation`;
  - a kind: `credit` (money, with its amount), or `apology`, `redo` or `priority` (no money);
  - a staff note.

  The holders of `experience.compensate` are told (`experience_compensation.proposed`, needs a decision). The inbox lists it as `compensation` (24 h) with its amount against the threshold.
- **Decided once, by the manager** (`POST /staff/experience/compensations/{id}/decide`). `experience.compensate` is the manager's and never a deputy's: it is money, like `finance.*`.
  - The locks, in order: the caller's account, the case (shared: a close waits), the compensation's row. Two decisions at once: one wins, the other is `409 COMPENSATION_DECIDED`.
  - A rejection takes a code (`compensationReject`).
- **A credit is finance's**, never a ledger of its own. The `CompensationCredits` port (core) is implemented by finance at startup, as `Charges` is. Approving a credit names one of the unit's invoices (`invoiceId`; another unit's is `INVOICE_NOT_FOUND`, a disputed one `INVOICE_DISPUTED`). Finance issues ADR 0058's compensation credit note on it exactly as its own credit does:
  - at most what credit notes may still take off it;
  - beyond what it owes, released to the unit's credit;
  - the unit told `compensation.granted` with the code, never the amount;
  - `credit_note.created` audited with the `compensationId`.
- **Above the limit, the board's own path.** The limit is `compensation_above_limit`'s threshold: a new approval type (ADR 0055), thresholded and bindable (ADR 0073), binding by default for every compound, with no amount until the compound sets one.
  - Above a binding threshold the manager raises a `compensation_above_limit` request of the amount (`POST /staff/governance/approvals`, the cost required). The board decides it as any request. Finance's `BoardAuthority` grants its authorization.
  - The decision then names it (`authorizationId`), and finance's `hold` uses it once, by this compensation, after the unit's finance locks.
  - Without it: `409 NEEDS_BOARD_APPROVAL`, and nothing is paid. Other refusals: `BOARD_AUTHORIZATION_EXCEEDED`, `…_USED`, `…_NOT_FOUND`. Within the threshold, `authorizationId` is `FIELD_NOT_ALLOWED`.
  - So a compensation above the limit is never paid before the board approves. The lock order and the authorization are ADR 0073's, not a second path.
- **The rules** (`experience_compensation_rules`, `GET`/`PUT /staff/experience/compensation-rules`): per failure code, the recommended kind and amount (a credit's), shown on a proposal. Audited per code.

### 6. The service promises register

- **`service_promises`:** what the compound promises, in both languages, measured where the data exists:
  - `ticket_resolution_hours` and `request_response_hours`: within so many hours (1–8760) for a share of the items (1–100 %);
  - `ticket_rating`, `request_rating`, `partner_rating`: an average of at least the target (1–5).

  A promise with no metric is listed, not measured. Retired with `active`, never deleted; at most 100.
- **`GET /staff/experience/promises/report?from&to`** gives each active promise's items, value and whether it was met, over the compound's days (at most 366).

### 7. The ratings report, and the board's

- **`GET /staff/experience/ratings-report?from&to`** (the compound's days, at most 366):
  - totals and per source;
  - the low ratings' reasons by frequency (with the share of the stated ones, and `unstated`);
  - per building;
  - the units with the compound's count of low ratings or more.

  Never who rated, never a comment.
- **The board's overview section `experience`** (ADR 0055's registry): the same totals, sources and reasons, the period's cases (opened, from signals, closed, open now) and approved compensations (count, credits, their total, how many by the board). Totals only, never a unit.
  - The spec's row "a low rating of his handling appears in the board's report, not on his dashboard" is met here: the management requests' ratings reach the board.
  - The monthly board report of ADR 0075 takes the overview's sections whole, so it will carry this one when M2-15 lands.

### 8. Personal data

- A low reason is a code on the rater's own rating: exported with it, kept at erasure like the rating.
- A case's, an outcome's and a compensation's notes, and a promise's titles, are staff words about a unit. They are plain data: never in the audit trail or a notification, and not in a resident's export, as a ticket's internal notes are not.

## Deviations from the plan (for the owner)

1. **No per-case due time.** A case is due by its kind's hours, set in the staff inbox like every type (follow-up 72 h, recovery 24 h). A manager who wants a case sooner sets its kind's hours. The inbox computes due times per type; a per-row due time would change ADR 0073's contract.
2. **`disengaged_after_bad_event` is not built.** The rules are repeated low ratings, tickets sent back and repeated complaints. Login data is 90 days in `account_logins` and could feed a fourth rule later.
3. **A credit names one of the unit's invoices.** Finance has no free credit to a unit, and a credit note is always on an invoice (ADR 0046). A unit with no open invoice is credited on a paid one (the money goes to its credit).
4. **The case's source is a reference.** A ticket, a request or a partner request named on a case is not checked against its domain (core reads no domain table). The dashboard sets it from the item's own page.
5. **Closing the loop with the resident is the staff's record**, not the resident's confirmation: the outcome and its note. A resident-side confirmation, and an auto-close after N days, are later.
6. **The manager still reads the request ratings** (`GET /management/request-ratings`, ADR 0039). The spec has the board read them; they now reach the board. Taking them from the manager is the owner's call.
7. **A low rating's reason is optional server-side** (changed by the owner, 2026-11-04): a 1 or a 2 without one is taken, and counted as unstated, until the resident apps ship the picker. Making it required is then a one-line change in `lowRatingReason`.
8. **No default compensation threshold.** It binds by default, but there is no amount until the compound sets one: until then the manager decides every compensation.

## Consequences

- New tables: `experience_settings`, `experience_counters`, `experience_cases`, `experience_signals`, `experience_compensation_rules`, `experience_compensations`, `service_promises`, each under RLS with composite keys. One column each on `ticket_feedback`, `management_request_ratings`, `partner_ratings`.
- Widened CHECKs:
  - the approval types and their settings;
  - the threshold and binding CHECKs;
  - `finance_board_authorizations`' type and use;
  - the staff inbox's types.
- The signals cost one read per rule per compound every 15 minutes, never a request's.

## Open

- A fourth rule from logins after a bad event, and an SLA-breach rule.
- A resident's side of a case (told, asked to confirm), and recovery steps as a checklist.
- Ticket reads here respect M2-13's sensitive tickets once it lands. The source reads only the rating and the unit, never the ticket's words.

## Update 2026-11-11: the credit's pickers

The decision dialog of a credit no longer asks for ids typed in. The invoice is chosen from the unit's own invoices (newest first, paged with "load more"; its number, due day, total and status), and, above the board's limit, the authorization from what the board approved as `compensation_above_limit`, still unused and at least the compensation's amount (`GET /staff/finance/board-authorizations?type=compensation_above_limit&unused=true`). Both lists are finance's (`finance.invoice`, which the manager holds); an account without it keeps typing the ids. Nothing changed in the API.
