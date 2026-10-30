# Money and the unit: backend notes for the mobile team

What was built for the resident's own unit and its money:
- the household's consumption, by month, compared, and against other homes;
- utility outages in the daily brief;
- what each fee pays for, and an invoice set against the one before;
- where the fees went, for every payer;
- a receipt as a PDF;
- a payment plan the resident asks for;
- what the unit will owe, by month;
- a field collector's visit.

The design decisions are in [ADR 0069](../../decisions/0069-money-and-the-unit.md). The contract is `docs/api/openapi.v0.json` (regenerated), with the Postman collection.

Conventions, as everywhere in API v0:

- Every path is under `/api/v1`, with `Authorization: Bearer <access token>`.
- Lists are `{ "data": [...], "nextCursor": string | null }`.
- Errors are `{ "statusCode", "code", "message", "params"?, "fields"?: [{ "field", "code", "params"? }], "requestId", ... }`. Switch on `code` and `fields[].code`, never on `message`.
- Creates take an optional `Idempotency-Key` header (a UUID).
- Money is an EGP string with two decimals (`"1250.00"`); use is a string with four (`"150.0000"`).
- Days are `YYYY-MM-DD`, the compound's; months `YYYY-MM`; instants ISO 8601 with an offset.

## Contents

1. [Consumption](#consumption)
2. [Outages in the brief](#outages-in-the-brief)
3. [Fees and invoice comparison](#fees-and-invoice-comparison)
4. [Where the fees went](#where-the-fees-went)
5. [Receipts as PDFs](#receipts-as-pdfs)
6. [Payment plans](#payment-plans)
7. [Upcoming dues](#upcoming-dues)
8. [Collector visits](#collector-visits)

## Consumption

Show it where `GET /me/units/{unitId}/capabilities` says `consumptionView: true`: who lives in the unit, or a member the primary gave `finance`. A landlord gets `403 CONSUMPTION_NOT_ALLOWED`.

`GET /units/{unitId}/consumption?from&to&kind?` (a period of at most 366 days; every kind the unit has a meter of when `kind` is left out):

```json
{
  "unitId": "…",
  "since": "2026-09-30",
  "period": { "from": "2026-05-01", "to": "2027-01-10", "days": 255 },
  "kinds": [
    {
      "kind": "electricity", "unit": "kWh", "meters": 1,
      "use": "250.0000", "estimatedCost": "500.00",
      "months": [
        { "month": "2026-11", "use": "150.0000", "estimatedCost": "300.00", "complete": true },
        { "month": "2026-12", "use": "100.0000", "estimatedCost": "200.00", "complete": true }
      ],
      "compare": {
        "month": "2026-12", "use": "100.0000",
        "previousMonth": { "month": "2026-11", "use": "150.0000" },
        "sameMonthLastYear": null
      }
    }
  ]
}
```

- `since` is the household's first day: nothing before it is read, whatever the period asks.
- `estimatedCost` is at the compound's tariffs: label it an estimate, never a bill. It is null where no tariff was in force.
- Only `complete` months are compared; a month the household did not live in all of is never compared.

`GET /units/{unitId}/consumption/benchmark?kind&month` (a month that has ended; `400 month INVALID_VALUE {latest}` otherwise): `available`, then `medianPerSqmDay`, `meanPerSqmDay` (other homes of the building, at least five) and `mine` (null when the household's month is not complete or its unit has no floor area). With `available: false`, `reason` is `TOO_FEW_UNITS` or `NO_BUILDING`: say there is no comparison yet.

Push `meter.unit_spike` (category `utilities`): `{ meterKind, readOn }`, target the unit. Open the consumption screen.

Saving tips are a compound document of kind `saving_tips` (`GET /compound-documents`).

## Outages in the brief

`GET /me/daily-brief` gains `outages`: `[{ id, kind, startsAt, endsAt }]`, the outages told to the caller that are under way or start within 48 hours, soonest first. `GET /me/outages` no longer carries `note`.

## Fees and invoice comparison

`GET /units/{unitId}/fees` (whoever sees the unit's money): each active fee — `nameEn/Ar`, `descriptionEn/Ar` (what it pays for), `kind`, `frequency`, `amount` (this unit's), `ownTerms`, `nextPeriod`, and `changes` (the latest first, at most 12): `{ fromAmount, toAmount, effectiveOn, decision: { publicationId, decidedOn } | null }`. Owners can open the decision under governance; tenants see its day.

`GET /invoices/{id}/comparison`: `total`, `previous` (`{ id, number, issuedOn, total }` or null: the first, or an instalment), `delta`, and `lines`: `{ descriptionEn, descriptionAr, amount, previousAmount, change: same|added|removed|changed, cause, decision }`. On a changed line of a plan's invoice, `cause` is `plan_amount_changed` (with `decision` when the board set it), `unit_terms`, or `other`.

## Where the fees went

`GET /finance/spending-reports` and `/{id}` (whoever sees some unit's money; tenants too): `fiscalYear`, `asOf`, `summaryEn/Ar`, `lines` (`category`, `allowance`, `spent`, `usedPct`), `totals`, `items` (`textEn/Ar`, `decision`). Push `finance.spending_report_published` (`{ fiscalYear, asOf }`).

## Receipts as PDFs

`GET /payments/{id}/receipt`: `application/pdf`, `Content-Disposition: attachment; filename="RC-000042.pdf"`, no-store. The same payment draws the same file. It names nobody; it prints the public link and code that verify it.

## Payment plans

- An invoice's detail (`GET /invoices/{id}`) gains `planOffer`: `{ mayRequest, offered, maxMonths, pendingRequestId }`. Show "Ask for a plan" while `mayRequest`; highlight it while `offered`.
- `POST /invoices/{id}/plan-requests { months }` (whoever pays the unit's money): `409 PLAN_REQUEST_PENDING {requestId}` when one waits; `409 INVOICE_NOT_CONVERTIBLE {reason}` (`instalment`, `has_plan`, `nothing_owed`); `409 INVOICE_DISPUTED`; `400 months INVALID_VALUE {max}`.
- `GET /plan-requests/{id}`, `POST /plan-requests/{id}/withdraw` (its requester, while it waits; else `409 PLAN_REQUEST_NOT_PENDING {status}`).
- Status: `pending`, `accepted` (with `planId`: open the instalment plan), `declined` (with `declineReason`), `withdrawn`, `lapsed` (the invoice was paid, credited or split meanwhile; the staff can no longer accept or decline it: `409 PLAN_REQUEST_LAPSED`).
- Pushes: `invoice.plan_available` (with a due-soon invoice), `instalment_plan_request.accepted`, `instalment_plan_request.declined` (`{ reasonCode }`). They appear in `GET /me/requests` as `instalment_plan_request`.

## Upcoming dues

`GET /units/{unitId}/upcoming-dues?months=3` (1 to 6): `overdue`, `months` (`{ month, invoiced, projected, total }`, this month first), `credit`, `net` (never below zero). A forecast: say so. Push `finance.dues_rising` (`{ month }`) where the compound turned it on.

## Collector visits

- `POST /units/{unitId}/collector-visits { windowStartsAt, windowEndsAt, expectedAmount? }` (whoever pays the unit's money): from tomorrow, within 14 days (`400 windowStartsAt INVALID_VALUE {maxDaysAhead}`), one to four hours (`400 windowEndsAt INVALID_VALUE {minHours, maxHours}`); one open a unit (`409 COLLECTOR_VISIT_OPEN {visitId}`).
- `GET /units/{unitId}/collector-visits`, `POST /collector-visits/{id}/cancel`, and `POST /collector-visits/{id}/accept-offer` (a failed visit's offered window, as a new visit; once).
- Status: `requested`, `assigned` (`assigned: true`, never who), `collected` (`paymentId`: its receipt), `failed` (`failReason`, maybe `offeredStartsAt/EndsAt`), `cancelled`.
- Pushes: `collector_visit.scheduled` (`{ windowStartsAt, windowEndsAt }`), `collector_visit.failed` (`{ reasonCode }`), and the payment's own `payment.received`.
- **The collector's app** (`finance.collect`): `GET /collector/visits`, `POST /collector/visits/{id}/collected { amount }` (at most what the unit owes plus the compound's margin: `400 AMOUNT_TOO_HIGH {max}`), `POST /collector/visits/{id}/failed { reasonCode, offeredStartsAt?, offeredEndsAt? }`. Pushes `collector_visit.assigned` and `collector_visit.cancelled`.
