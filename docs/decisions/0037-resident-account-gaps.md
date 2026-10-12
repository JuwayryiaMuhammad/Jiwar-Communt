# 0037 — The resident's unit and worker screens

**Status:** Accepted · Resident journey (Figma, "الساكن")

## Context

The resident journey in Figma shows unit and worker steps that the API does not have yet. This ADR adds them one at a time. Each section below is one change. None of them takes anything away from an existing route or view, and no existing permission is widened.

## Decisions

### The unit card

The design's unit card and "Data → Unit Details" show the unit's type, its area and whether it is active.

- `GET /me/units` gains `unitType`, `areaSqm` and `status` on every item, for the resident and the family member alike. No migration: `unit_type`, `area_sqm` and `closed_since` already exist (ADR 0020).
  - `areaSqm` is a string with two decimals, like `GET /units/:id`. The design shows square feet; the app converts.
  - `status` is `active`, or `closed` while the unit is in closed-unit mode.
- `GET /units/:id` keeps `units.read`. A resident reads their units through `/me/units`, which only ever lists the caller's own active occupancies and memberships, so there is nothing to check per unit and nothing of a neighbour's to leak.
- **Not done:** editing the type or the area. The primary can already fill a *missing* detail (`POST /units/:id/details`, where the manager's value wins); the design's pencil icons suggest changing an existing value too. That needs a decision about who wins (open question below).

### A worker's wage and its payments

The design's worker page shows "Monthly Wage · Pay Wage", a form with an amount and a period, and "Payment sent. Receipt delivered to both parties."

- **Recorded, not processed.** There is no payment gateway, so the household records that it paid. Nothing moves money, and the receipt says so.
- **The employer side.** A wage is between the worker and whoever employs them, not the whole household. The employer side of an engagement is the unit's primary, a live `workers` delegate, and the engagement's requester (for that engagement only, while they still live in the unit). Only they set the wage, record a payment, and read either. There is no `workers` member permission today; a delegation is how a member joins the employer side.
- **Never staff or a manager.** Setting a wage and recording a payment are refused (403 `FORBIDDEN`) for a staff or manager account by what the account is, before anything else is checked, whatever its role holds. `workers.manage` already belongs to residents and family only; the service does not rely on that.
- **The wage:** `worker_engagements.monthly_wage` (two decimals, nullable). `PUT /worker-engagements/:id/wage` (`workers.manage`) sets it, or clears it with `null`, while the engagement is open (`ENGAGEMENT_NOT_FOUND` otherwise, like every engagement action). The unit's worker list (`GET /units/:unitId/workers`) carries `monthlyWage` for the employer side; for any other member of the household the field is absent (not null), and they see the worker as before. The trail records `worker.wage_changed` with whether it was set, never the amount.
- **A payment:** `POST /worker-engagements/:id/wage-payments` (`workers.manage`) with `period` (`YYYY-MM`) and `amount` (positive, at most two decimals and one million). It need not equal the wage: a partial month or a bonus is the household's business.
  - **Who:** the employer side (`WorkersAuthority.forEngagement`). A household member, a landlord or a neighbour is refused as for every engagement action.
  - **When:** the engagement is `active`, `suspended` or `ended` and once had a code (someone could have worked). Pending or rejected: 409 `WAGE_NOT_PAYABLE`.
  - **Which month:** not after the compound's current month (its time zone), not before the month the engagement was created (`WAGE_PERIOD_IN_FUTURE`, `WAGE_PERIOD_BEFORE_ENGAGEMENT`).
  - **Once per month:** under the unit's lock (every engagement change takes it), a second payment for the same month is 409 `WAGE_PERIOD_ALREADY_PAID`. A unique index (`worker_wage_payments_one_per_period`) backs it, so two at once give one payment.
- **Receipts, "to both parties":** the worker gets a `wage_paid` worker notice (period and amount; a future SMS channel delivers worker notices, ADR 0017). The payer and the unit's primary get an email (`community.wage_paid`, Arabic or English, through the outbox).
- **Where the amount goes:** the payment views, the worker's notice and those two emails. Nowhere else: no other notification carries it, a payment writes nothing to the audit trail, and `worker.wage_changed` never holds it.
- **How the receipt is delivered (ADR 0036):** `community.wage_paid` is classed by name: category `household`, not critical (quiet hours and a pause hold it), and the sole record of what it says (a held receipt is never dropped).
- **A payment settles nothing (ADR 0022).** The household's own record does not close the wage obligation of an ended engagement, of either kind; that stays open, and keeps blocking the employer's account deletion (`open_worker_obligations`, ADR 0036), until management closes it (below).
- **Reading:** `GET /worker-engagements/:id/wage-payments` (`workers.manage` or `workers.review`), newest first, a page at a time: the employer side, and the managers who review workers (payroll). Those managers also read `monthlyWage` in their own views, `GET /worker-engagements` and `GET /worker-engagements/:id` (`workers.review`), always present there (null until set).
- **Export (ADR 0036):** `workers.json` gains `monthlyWage` for the engagements the account registered, and `wage-payments.json` lists the payments the account recorded itself (`paymentId`, `engagementId`, `unitCode`, `workerName`, `period`, `amount`, `paidAt`).
- **Storage:** `worker_wage_payments` is append-only like `gate_entries` (ADR 0028): SELECT and INSERT for the app, triggers refusing UPDATE, DELETE and TRUNCATE, no foreign keys. A wrong payment is not edited; correcting it is an open question.
- **Currency:** amounts are in the compound's currency (EGP). There is no currency column until finance adds one.

### A manager closes the wage obligation

Nothing closed a wage obligation before (ADR 0022 only records it), and a household's own record must not.

- `POST /worker-engagements/:id/wage-obligation/settle` (`workers.review`, and a manager account by type) with `reasonCode`, from a new closed list (`REASON_CODES.wageObligationSettle`): `household_payment_confirmed` (the manager checked the household's recorded payments), `worker_confirmed` (the worker says they were paid), `nothing_owed`. A code only, never text.
- It closes the engagement's open `settle_before_close` obligation: `settled_at`, `settled_by` and the new `settle_reason_code` are written together, and a CHECK keeps them all set or all null. No open one: 409 `WAGE_OBLIGATION_NOT_OPEN`. It takes the unit's lock, so two managers at once settle it once.
- Audited as `worker.wage_obligation_settled` (obligation id, kind, reason code; no amount, no name).
- The underage `pay_in_full` obligation was first left out of this route; the update below takes it in.
- The manager's `GET /worker-engagements/:id` gains `openWageObligations` (the kinds still open), so the screen knows when to offer it.
- From then on the deletion blocker (`open_worker_obligations`, ADR 0036) no longer counts it.

### One of the unit's workers

The design's worker page (allowed hours, last check-in, monthly wage, Pay Wage, Terminate) is one engagement; residents had only the unit's list.

- `GET /units/:unitId/workers/:id` (`workers.manage`): the list item, plus `lastPaidPeriod` (the latest month with a recorded payment). `monthlyWage` and `lastPaidPeriod` are for the employer side only, as in the list: absent for any other member of the household, who still reads the rest of the page.
- **The resident's own only:** the unit is checked first, exactly like the list (`UNIT_NOT_FOUND` for a unit the caller has no place in; a landlord sees the unit but never who works in it). Then the engagement must be that unit's and not rejected (`ENGAGEMENT_NOT_FOUND` otherwise, also for another unit's id through this path).
- `GET /worker-engagements/:id` keeps `workers.review`: it is the manager's view, with the document and the birth date.
- "Last check-in" stays `GET /worker-engagements/:id/attendance`, which residents already read (`workers.manage`): the community domain does not read the gate's entries (ADR 0015).

## Open questions

- May a resident change a unit's type or area once the manager has set it, or only propose a correction?
- A wage payment recorded by mistake cannot be edited or removed (append-only). Should a correction be a reversal row, by the household or by management?

## Update (B2)
- **The settle route takes a `kind`** (`settle_before_close` by default, or `pay_in_full`), because one engagement may hold both open: an underage report on work that then ends. Each kind closes alone and has its own reason list (`wageObligationSettle`, `wageObligationPayInFull`; ADR 0022's update); a code from the other list is `INVALID_REASON_CODE` with the kind's `allowed`.
- Same lock, same columns, same 409 `WAGE_OBLIGATION_NOT_OPEN` (now: none of that kind is open), same audit action (`worker.wage_obligation_settled`, whose metadata already carries the kind). No schema change: the CHECK on the three settlement columns never depended on the kind.
- A recorded payment still settles nothing, of either kind.
