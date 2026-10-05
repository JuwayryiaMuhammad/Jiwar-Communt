# 0037 — The resident's unit, workers and settings screens

**Status:** Accepted · Resident journey (Figma, "الساكن")

## Context

The resident journey in Figma shows unit, worker and settings steps that the API does not have yet. This ADR adds them one at a time. Each section below is one change. None of them takes anything away from an existing route or view, and no existing permission is widened.

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
- **The wage:** `worker_engagements.monthly_wage` (two decimals, nullable). `PUT /worker-engagements/:id/wage` (`workers.manage`) sets it, or clears it with `null`, while the engagement is open (`ENGAGEMENT_NOT_FOUND` otherwise, like every engagement action). The unit's worker list (`GET /units/:unitId/workers`) shows it. The trail records `worker.wage_changed` with whether it was set, never the amount.
- **A payment:** `POST /worker-engagements/:id/wage-payments` (`workers.manage`) with `period` (`YYYY-MM`) and `amount` (positive, at most two decimals and one million). It need not equal the wage: a partial month or a bonus is the household's business.
  - **Who:** whoever may act on the engagement (`WorkersAuthority.forEngagement`): its requester, the unit's primary or a `workers` delegate. A household member, a landlord or a neighbour is refused as for every engagement action. A manager never pays.
  - **When:** the engagement is `active`, `suspended` or `ended` and once had a code (someone could have worked). Pending or rejected: 409 `WAGE_NOT_PAYABLE`.
  - **Which month:** not after the compound's current month (its time zone), not before the month the engagement was created (`WAGE_PERIOD_IN_FUTURE`, `WAGE_PERIOD_BEFORE_ENGAGEMENT`).
  - **Once per month:** under the unit's lock (every engagement change takes it), a second payment for the same month is 409 `WAGE_PERIOD_ALREADY_PAID`. A unique index (`worker_wage_payments_one_per_period`) backs it, so two at once give one payment.
- **Receipts, "to both parties":** the worker gets a `wage_paid` worker notice (period and amount; a future SMS channel delivers worker notices, ADR 0017). The payer and the unit's primary get an email (`community.wage_paid`, Arabic or English, through the outbox).
- **The obligation (ADR 0022):** a payment on an engagement that has **ended** settles its open `settle_before_close` obligation (`settled_at`, `settled_by`), audited as `worker.wage_obligation_settled` with the payment's id. The underage `pay_in_full` obligation stays with management: a household's own record does not close a compliance matter.
- **Reading:** `GET /worker-engagements/:id/wage-payments` (`workers.manage` or `workers.review`), newest first, a page at a time. Managers read them for payroll.
- **Storage:** `worker_wage_payments` is append-only like `gate_entries` (ADR 0028): SELECT and INSERT for the app, triggers refusing UPDATE, DELETE and TRUNCATE, no foreign keys. A wrong payment is not edited; correcting it is an open question.
- **Currency:** amounts are in the compound's currency (EGP). There is no currency column until finance adds one.

### One of the unit's workers

The design's worker page (allowed hours, last check-in, monthly wage, Pay Wage, Terminate) is one engagement; residents had only the unit's list.

- `GET /units/:unitId/workers/:id` (`workers.manage`): the list item, plus `lastPaidPeriod` (the latest month with a recorded payment).
- **The resident's own only:** the unit is checked first, exactly like the list (`UNIT_NOT_FOUND` for a unit the caller has no place in; a landlord sees the unit but never who works in it). Then the engagement must be that unit's and not rejected (`ENGAGEMENT_NOT_FOUND` otherwise, also for another unit's id through this path).
- `GET /worker-engagements/:id` keeps `workers.review`: it is the manager's view, with the document and the birth date.
- "Last check-in" stays `GET /worker-engagements/:id/attendance`, which residents already read (`workers.manage`): the community domain does not read the gate's entries (ADR 0015).

## Open questions

- May a resident change a unit's type or area once the manager has set it, or only propose a correction?
- A wage payment recorded by mistake cannot be edited or removed (append-only). Should a correction be a reversal row, by the household or by management?
- Should any payment after an engagement ended settle its obligation, or only one the household marks as the final settlement?
