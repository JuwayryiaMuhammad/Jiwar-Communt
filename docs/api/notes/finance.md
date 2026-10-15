# Finance — invoices and payments: backend notes for the mobile team

What was built for the resident app's money screens (a unit's invoices, paying online, receipts).
- The design decisions are in [ADR 0046](../../decisions/0046-finance-invoices-and-payments.md).
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
6. [Push notifications](#push-notifications)
7. [Value lists](#value-lists)
8. [Errors to handle](#errors-to-handle)

## Who sees and pays

Read the unit's capabilities (`GET /me/units/{unitId}/capabilities`):
- `financeView`: may see the unit's invoices, payments, receipts and statement — owners (landlords too), tenants, and members the primary gave `finance`.
- `financePay`: may pay online. A member also has `financeCapPerOperation`: a basket above it is refused (`FINANCE_CAP_EXCEEDED`, `params.cap`).
- Both are false under a death review (`HOUSEHOLD_UNDER_REVIEW` when trying to pay).

Without `financeView`, the unit's money routes answer 403 `FORBIDDEN` (a unit you have a place in) or 404 (a unit you do not); one invoice, payment or checkout you may not see is 404.

## A unit's invoices

- `GET /units/{unitId}/invoices?status=` — newest first. `status` is `unpaid`, `partially_paid`, `overdue`, `paid`, `credited`, or `open` (anything still owed).
- `GET /invoices/{id}` — one invoice: `lines` (English and Arabic descriptions, amounts), `creditNotes`, `allocations` (the payments that paid it; `reversed: true` ones no longer count), and `plan` (`{ periodStartsOn, periodEndsOn }` when a billing plan issued it; `periodEndsOn` excluded).

Each invoice carries `total`, `credited`, `paid` and `outstanding` (what is still owed) and its `status`. An invoice never changes once issued: corrections come as credit notes.

## The statement

`GET /units/{unitId}/statement` — the unit's money screen in one call:
- `outstanding`: everything still owed;
- `credit`: paid beyond what was owed (a late online payment, say), applied by itself to the unit's next invoices;
- `openInvoices`: every invoice still owed, oldest due first;
- `entries`: the latest 100 entries, newest first (`invoice`, `credit_note`, `payment`, `reversal`, with their numbers);
- `onlinePayment`: whether the compound takes online payment now. Hide the pay button when false.

## Paying online

Card or mobile wallet, on **Paymob's hosted page** (the app never sees card data).

1. `POST /units/{unitId}/payment-sessions` with `{ "invoiceIds": [...] }`, or `{}` for everything owed (the first 50 invoices, oldest due first). Answers `201` with:
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
- Each payment: `channel` (`online` or `office`), `method`, `amount`, `paidOn`, `receiptNumber` (`RC-000123`), `receiptCode`, `receiptUrl` (`<public site>/receipt#<code>`), `allocated`, `unallocated` (the part that became credit), and `reversal` when the office reversed it.
- **Sharing a receipt:** share `receiptUrl`. Anyone who opens it sees the compound, the number, the amount, the day and whether it stands (`valid` or `reversed`) — no name, no unit.

## Push notifications

Category `finance` (a switch in the notification preferences). None is critical, and **none carries a param**: open the target to show details.

| Kind | Target | en | ar |
|---|---|---|---|
| `invoice.issued` | invoice | New invoice / A new invoice was issued for your unit. Open the app for details. | فاتورة جديدة / صدرت فاتورة جديدة لوحدتك. افتح التطبيق لمعرفة التفاصيل. |
| `invoice.due_soon` | invoice | Invoice due soon / An invoice for your unit is due in a few days. | فاتورة مستحقة قريبًا / تستحق فاتورة لوحدتك خلال أيام. |
| `invoice.overdue` | invoice | Invoice overdue / An invoice for your unit is past its due date. | فاتورة متأخرة / تجاوزت فاتورة لوحدتك تاريخ استحقاقها. |
| `payment.received` | payment | Payment received / A payment for your unit was received. Your receipt is in the app. | تم استلام دفعة / تم استلام دفعة لوحدتك. الإيصال متاح في التطبيق. |

They reach everyone who sees the unit's money (`financeView`), the payer included.

## Value lists

| List | Values |
|---|---|
| Invoice kind | `service_charge`, `maintenance`, `other` |
| Invoice status | `unpaid`, `partially_paid`, `overdue`, `paid`, `credited` |
| Payment channel | `online`, `office` |
| Payment method | `card`, `wallet` (online); `cash`, `bank_transfer`, `cheque` (office) |
| Checkout status | `opening`, `open`, `succeeded`, `failed`, `expired`, `superseded` |
| Credit note reason | `billing_error`, `waiver`, `duplicate`, `goodwill`, `other` |
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
| `INVOICE_NOT_FOUND`, `PAYMENT_NOT_FOUND`, `PAYMENT_SESSION_NOT_FOUND` (404) | Unknown, or not yours to see. |
