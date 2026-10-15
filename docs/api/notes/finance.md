# Finance — invoices and payments: backend notes for the mobile team

What was built for the resident app's money screens: a unit's invoices, paying online, receipts, and (part 2) instalments, disputing an invoice, and refunds on the statement.
- The design decisions are in [ADR 0046](../../decisions/0046-finance-invoices-and-payments.md) and [ADR 0048](../../decisions/0048-finance-instalments-disputes-refunds-ledger-reports.md).
- The contract is `docs/api/openapi.v0.json` (regenerated) and the Postman collection.

Conventions, as everywhere in API v0:

- Every path is under `/api/v1`, with `Authorization: Bearer <access token>`.
- Lists are `{ "data": [...], "nextCursor": string | null }`; pass `nextCursor` back as `?cursor=`.
- Errors are `{ "statusCode", "code", "message", "params"?, "fields"?: [...], "requestId" }`. Switch on `code` and `fields[].code`, never on `message`.
- Creates take an optional `Idempotency-Key` header: a retry with the same key answers the same, once.
- Money is a decimal string with two decimals, in EGP (`"1500.00"`). Days are the compound's local days, `YYYY-MM-DD`.

## Contents

1. [Who sees and pays](#who-sees-and-pays)
2. [A unit's invoices](#a-units-invoices)
3. [The statement](#the-statement)
4. [Paying online](#paying-online)
5. [Payments and receipts](#payments-and-receipts)
6. [Instalments](#instalments)
7. [Disputing an invoice](#disputing-an-invoice)
8. [Refunds and released money on the statement](#refunds-and-released-money-on-the-statement)
9. [Push notifications](#push-notifications)
10. [Value lists](#value-lists)
11. [Errors to handle](#errors-to-handle)

## Who sees and pays

Read the unit's capabilities (`GET /me/units/{unitId}/capabilities`):
- `financeView`: may see the unit's invoices, payments, receipts and statement — owners (landlords too), tenants, and members the primary gave `finance`.
- `financePay`: may pay online. A member also has `financeCapPerOperation`: a basket above it is refused (`FINANCE_CAP_EXCEEDED`, `params.cap`).
- Both are false under a death review (`HOUSEHOLD_UNDER_REVIEW` when trying to pay).

Without `financeView`, the unit's money routes answer 403 `FORBIDDEN` (a unit you have a place in) or 404 (a unit you do not); one invoice, payment or checkout you may not see is 404.

## A unit's invoices

- `GET /units/{unitId}/invoices?status=` — newest first. `status` is `unpaid`, `partially_paid`, `overdue`, `paid`, `credited`, `rescheduled`, or `open` (anything still owed).
- `GET /invoices/{id}` — one invoice: `lines` (English and Arabic descriptions, amounts), `creditNotes`, `allocations` (the payments that paid it; `reversed: true` ones no longer count), and `plan` (`{ periodStartsOn, periodEndsOn }` when a billing plan issued it; `periodEndsOn` excluded). Part 2 adds:
  - `instalmentPlan`: `{ id, number, position, count }` on an instalment (see [Instalments](#instalments));
  - `rescheduledBy`: `{ id, number }` on an invoice a plan took over;
  - `dispute`: `{ id, status, mine }`, its latest dispute (see [Disputing an invoice](#disputing-an-invoice));
  - on each credit note and allocation, `released`: paid money given back to the unit's credit (see [the statement](#refunds-and-released-money-on-the-statement)).

Each invoice carries `total`, `credited`, `paid` and `outstanding` (what is still owed) and its `status`. An invoice never changes once issued: corrections come as credit notes.

## The statement

`GET /units/{unitId}/statement` — the unit's money screen in one call:
- `outstanding`: everything still owed;
- `credit`: paid beyond what was owed (a late online payment, say) or released by a credit note, and not refunded; applied by itself to the unit's next invoices;
- `openInvoices`: every invoice still owed, oldest due first;
- `entries`: the latest 100 entries, newest first (`invoice`, `credit_note`, `payment`, `reversal`, `refund`, `refund_reversal`, with their numbers; a credit note's `released`);
- `onlinePayment`: whether the compound takes online payment now. Hide the pay button when false.

## Paying online

Card or mobile wallet, on **Paymob's hosted page** (the app never sees card data).

1. `POST /units/{unitId}/payment-sessions` with `{ "invoiceIds": [...] }`, or `{}` for everything owed (the first 50 invoices, oldest due first; an invoice under an open dispute is left out, and naming it is `409 INVOICE_DISPUTED`). Answers `201` with:
   - `id`, `status` (`open`), `amount`, `expiresAt` (30 minutes), `invoices` (each with the amount it owed when the checkout opened);
   - `checkoutUrl`: open it in an in-app browser (or the system browser).
2. The same basket by the same person reuses the open checkout (same `id`, same `checkoutUrl`). Another basket, or another payer of the unit, replaces it. `409 PAYMENT_SESSION_IN_FLIGHT`: another request for the unit is opening one right now — retry in a second.
3. When the hosted page finishes, it returns to `<public site>/paid`, which only says "go back to the app". **That return proves nothing.**
4. **Poll `GET /payment-sessions/{id}`** (every 2–3 s for a minute, then on screen focus):
   - `succeeded`: paid; `payment` has its id and receipt number. Show the receipt (`GET /payments/{id}`).
   - `open`: not confirmed yet. `lastAttempt: "failed"` means the last attempt on the page failed and the payer may try again there while it is open.
   - `expired` / `superseded`: no longer the unit's checkout. If the payer completed the page anyway, the payment still lands (as a payment and, beyond what was owed, as credit): keep polling a little, or reload the statement.
   - `failed`: Paymob could not open the page; open a new checkout.
   `checkoutUrl` comes back only to the payer, while it is open.
5. Paymob confirms the payment to the server; only then does it count. It may take a short while.

Other answers when opening: `409 ONLINE_PAYMENT_UNAVAILABLE` (switched off, or not set up), `409 NOTHING_TO_PAY`, `409 INVOICE_NOT_PAYABLE` (`params.invoiceIds`: not the unit's, or nothing owed), `502 PAYMENT_GATEWAY_ERROR` (Paymob did not answer: try again).

## Payments and receipts

- `GET /units/{unitId}/payments` — newest first; `GET /payments/{id}` — one payment with `allocations` (the invoices it paid).
- Each payment: `channel` (`online` or `office`), `method`, `amount`, `paidOn`, `receiptNumber` (`RC-000123`), `receiptCode`, `receiptUrl` (`<public site>/receipt#<code>`), `allocated` (net of what credit notes released), `refunded` (what refunds paid back of it), `unallocated` (the part that is credit now), and `reversal` when the office reversed it.
- **Sharing a receipt:** share `receiptUrl`. Anyone who opens it sees the compound, the number, the amount, the day and whether it stands (`valid` or `reversed`) — no name, no unit.

## Instalments

The office may split what an invoice owes into 2–24 **instalments** (ADR 0048). Each instalment is an ordinary invoice of its own, with its own number, due day, status and reminders, paid online or at the office like any other.

- The original invoice now reads `rescheduled` (nothing owed on it; a credit note of reason `instalment_plan` closed it) and carries `rescheduledBy`.
- Each instalment carries `instalmentPlan`: `{ id, number, position, count }` ("Instalment 2 of 3"). Its line reads "Instalment 2 of 3 — INV-000123" / "القسط 2 من 3 — INV-000123".
- `GET /instalment-plans/{id}` (whoever sees the unit's money): the plan with `number` (`IP-000004`), `invoiceNumber`, `instalmentCount`, `total`, `outstanding`, `status` (`active`, `settled`, `cancelled`) and `instalments` (each an invoice view plus `position`), in order.
- The unit is told once (`instalment_plan.created`), not once per instalment. Each instalment still gets its due-soon and overdue reminders.
- If the office cancels the plan, what the instalments owed is credited off them (they read `rescheduled`) and asked for again in one new invoice ("Remainder of instalment plan IP-000004"), announced as `invoice.issued`. The plan then has `remainderInvoiceId` and `remainderInvoiceNumber`.

Suggested screen: show `rescheduled` invoices greyed with a link to the plan; on the plan, a schedule with each instalment's status and a pay button on the open ones.

## Disputing an invoice

Whoever sees a unit's money (`financeView`) may dispute one of its invoices **that still owes something** (ADR 0048).

1. Optionally, upload a photo the 3-step way: `POST /files/uploads` with `{ "purpose": "dispute_photo", "contentType": "image/jpeg" | "image/png" | "image/webp", "size": <bytes ≤ 5 MB> }`, PUT the bytes, then `POST /files/{id}/finalize`.
2. `POST /invoices/{id}/disputes` with `{ "reasonCode": "...", "text"?: "1–1000 characters", "photoFileId"?: "<finalized upload>" }` and an `Idempotency-Key`. Answers `201` with the dispute.
   - Reasons: `already_paid`, `wrong_amount`, `not_my_unit`, `service_not_provided`, `duplicate_invoice`, `other`.
   - A file that is not your finalized `dispute_photo` upload gets field `photoFileId`, `FILE_NOT_AVAILABLE`.
3. While the dispute is open, the invoice is **frozen**: no due-soon or overdue reminder; it cannot be paid by name (a checkout of "everything owed" leaves it out); the unit's credit does not pay it. Opening a dispute closes the unit's open checkout.
4. The office decides once. You get a push (only the person who opened it): `invoice.dispute_accepted` (a credit note took part or all of it off) or `invoice.dispute_rejected` (with a reason).

Reading:
- `GET /invoices/{id}/disputes`: the invoice's disputes, newest first; `GET /invoice-disputes/{id}`: one.
- Each: `reasonCode`, `status` (`open`, `accepted`, `rejected`), `decision` (`{ decidedAt, reasonCode, creditedAmount, creditNoteId, creditNoteNumber }` once decided), `mine`.
- **`text` and `photoUrl` are shown to their author only** (`mine: true`); for the unit's other viewers they are `null`. `photoUrl` is short-lived: do not store it.
- These responses are `Cache-Control: no-store`.
- After a decision the invoice may be disputed again, three times in all (`DISPUTE_LIMIT_REACHED`).
- Erasing your account clears your words and photo; the dispute stays with its code.

Rejection reasons, to label: `charge_is_correct`, `payment_not_found`, `outside_policy`, `no_longer_owed` (it was paid meanwhile), `other`.

## Refunds and released money on the statement

- The office may pay back a unit's **credit** (ADR 0048): by cash, bank transfer, or by hand in the payment provider's dashboard. It shows on the statement as a `refund` entry (`RF-000007`), and the statement's `credit` is net of it. A mistaken refund is reversed (`refund_reversal`): the money is credit again and pays what the unit owes.
- When the office credits an invoice that was already paid, the paid money beyond what it owed is **released** to the unit's credit: the credit note's `released` (on the invoice and on the statement entry) says how much. That credit then pays the unit's other invoices by itself, or can be refunded.
- There is no push for a refund: reload the statement on focus.

## Push notifications

Category `finance` (a switch in the notification preferences). None is critical, and **none carries a param**: open the target to show details.

| Kind | Target | en | ar |
|---|---|---|---|
| `invoice.issued` | invoice | New invoice / A new invoice was issued for your unit. Open the app for details. | فاتورة جديدة / صدرت فاتورة جديدة لوحدتك. افتح التطبيق لمعرفة التفاصيل. |
| `invoice.due_soon` | invoice | Invoice due soon / An invoice for your unit is due in a few days. | فاتورة مستحقة قريبًا / تستحق فاتورة لوحدتك خلال أيام. |
| `invoice.overdue` | invoice | Invoice overdue / An invoice for your unit is past its due date. | فاتورة متأخرة / تجاوزت فاتورة لوحدتك تاريخ استحقاقها. |
| `payment.received` | payment | Payment received / A payment for your unit was received. Your receipt is in the app. | تم استلام دفعة / تم استلام دفعة لوحدتك. الإيصال متاح في التطبيق. |
| `instalment_plan.created` | instalment_plan | Instalment plan set up / An invoice for your unit was split into instalments. Open the app for the schedule. | تم إنشاء خطة تقسيط / تم تقسيط فاتورة لوحدتك. افتح التطبيق لمعرفة مواعيد الأقساط. |
| `invoice.dispute_accepted` | invoice_dispute | Dispute accepted / Your dispute of an invoice was accepted. Open the app for the new amount. | تم قبول الاعتراض / تم قبول اعتراضك على فاتورة. افتح التطبيق لمعرفة المبلغ الجديد. |
| `invoice.dispute_rejected` | invoice_dispute | Dispute not accepted / Your dispute of an invoice was not accepted. Open the app for the reason. | لم يتم قبول الاعتراض / لم يتم قبول اعتراضك على فاتورة. افتح التطبيق لمعرفة السبب. |

They reach everyone who sees the unit's money (`financeView`), the payer included; a dispute's decision reaches only the person who opened it.

## Value lists

| List | Values |
|---|---|
| Invoice kind | `service_charge`, `maintenance`, `other` |
| Invoice status | `unpaid`, `partially_paid`, `overdue`, `paid`, `credited`, `rescheduled` |
| Instalment plan status | `active`, `settled`, `cancelled` |
| Dispute status | `open`, `accepted`, `rejected` |
| Dispute reason | `already_paid`, `wrong_amount`, `not_my_unit`, `service_not_provided`, `duplicate_invoice`, `other` |
| Dispute rejection reason | `charge_is_correct`, `payment_not_found`, `outside_policy`, `no_longer_owed`, `other` |
| Statement entry | `invoice`, `credit_note`, `payment`, `reversal`, `refund`, `refund_reversal` |
| Refund channel | `cash`, `bank_transfer`, `gateway_manual` |
| Payment channel | `online`, `office` |
| Payment method | `card`, `wallet` (online); `cash`, `bank_transfer`, `cheque` (office) |
| Checkout status | `opening`, `open`, `succeeded`, `failed`, `expired`, `superseded` |
| Credit note reason | `billing_error`, `waiver`, `duplicate`, `goodwill`, `other`; and the system's `instalment_plan`, `dispute` |
| Payment reversal reason | `entered_in_error`, `duplicate`, `bounced_cheque`, `other` |

Labels are the app's: translate the codes.

## Errors to handle

| Code | When |
|---|---|
| `FORBIDDEN` (403) | The unit's money is not yours to see. |
| `FINANCE_CAP_EXCEEDED` (403) | Above your cap per operation (`params.cap`). |
| `HOUSEHOLD_UNDER_REVIEW` (403) | Financial actions are paused on this unit. |
| `ONLINE_PAYMENT_UNAVAILABLE` (409) | The compound takes no online payment now. |
| `NOTHING_TO_PAY` (409) | The unit owes nothing. |
| `INVOICE_NOT_PAYABLE` (409) | One of the invoices is paid already, or not this unit's. |
| `PAYMENT_SESSION_IN_FLIGHT` (409) | Opening one right now: retry shortly. |
| `PAYMENT_GATEWAY_ERROR` (502) | Paymob did not answer: try again. |
| `INVOICE_DISPUTED` (409) | The invoice is under an open dispute: it cannot be paid by name (`params.invoiceIds`). |
| `INVOICE_NOT_DISPUTABLE` (409) | Nothing is owed on the invoice. |
| `DISPUTE_ALREADY_OPEN` (409) | The invoice has an open dispute already. |
| `DISPUTE_LIMIT_REACHED` (409) | Disputed `params.max` times already. |
| `INVOICE_NOT_FOUND`, `PAYMENT_NOT_FOUND`, `PAYMENT_SESSION_NOT_FOUND`, `INSTALMENT_PLAN_NOT_FOUND`, `DISPUTE_NOT_FOUND` (404) | Unknown, or not yours to see. |
