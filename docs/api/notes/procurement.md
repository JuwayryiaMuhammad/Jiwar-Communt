# Vendors, contracts and purchase requests (ADR 0077)

For the manager's dashboard. All routes are staff routes.

## The vendor register — `/staff/vendors`

- `GET /staff/vendors?status=&category=&q=` lists `VendorSummaryView` in register order (`q` matches the name or legal name, whatever the case). `GET /staff/vendors/{id}` is a `VendorView`: its live `documents` (each with `expired` and a short-lived `fileUrl`), `documentsExpired`, the last year's `evaluations` (`count`, `averages` per criterion and `overall`), and `contracts` (`total`, `active`).
- `POST /staff/vendors` (idempotent) and `PATCH /staff/vendors/{id}`: a name taken in the compound is `409 VENDOR_NAME_TAKEN {vendorId}`; a partner already another vendor's is `409 VENDOR_PARTNER_TAKEN {vendorId}`.
- `POST /staff/vendors/{id}/suspend {reasonCode}` (`vendorSuspend`) and `/reinstate`; the wrong state is `409 VENDOR_WRONG_STATUS {status}`.
- `POST /staff/vendors/{id}/documents {kind, fileId, number?, issuedOn?, expiresOn?}`: upload the file first with purpose `vendor_document`. `DELETE /staff/vendors/{id}/documents/{documentId}` removes one filed by mistake.
- `POST /staff/vendors/{id}/evaluations {quality, timeliness, cost, communication, safety, contractId?, note?}` (each 1–5) returns the `VendorView`; `GET …/evaluations` pages them, newest first.
- A suspended vendor is refused (`409 VENDOR_SUSPENDED`) wherever something new names it: a contract, an expense, a purchase request.

## Contracts — `/maintenance/contracts`

- Create with `vendorId`, or `vendorName` (found in the register or registered). New optional fields: `latePenaltyPerDay`, `penaltyCap` (needs the daily penalty), `responseHours`, `penaltyTerms`, `autoRenews` (needs `renewalTermMonths`), `budgetLineId`, `approvalRequestId`.
- Above the major contract threshold: `409 CONTRACT_NEEDS_APPROVAL {threshold}` until an approved major contract of at least the value is named; `409 CONTRACT_APPROVAL_INVALID {reason: not_approved | below_value | signs_another}`.
- `POST /maintenance/contracts/{id}/renew {code, endsOn, startsOn?, annualValue?, approvalRequestId?}` makes the new contract (`renewsId`); the old one shows `renewalId`. Twice is `409 CONTRACT_ALREADY_RENEWED {renewalId}`.
- `GET` / `PUT /maintenance/contracts/{id}/payments {payments: [{dueOn, amount, note?}]}`: the unpaid schedule replaced whole; a paid day is `409 CONTRACT_PAYMENT_PAID {dueOn}`. `POST …/payments/{paymentId}/pay {paidOn, reference?}` once.
- `GET /maintenance/contract-payments/due?from=&to=`: unpaid payments of contracts in force between two days, with the contract's code and vendor (`assets.manage` or `finance.budget`).

## Expenses

`POST /staff/finance/expenses` takes `vendorId` (then `vendor` may be left out) or `vendor` in words; words naming a vendor of the register link to it. The `ExpenseView` gains `vendorId`.

## Purchase requests — `/staff/purchase-requests`

- `POST` (idempotent, `purchases.request`): `{title, estimatedAmount, description?, vendorId?, budgetLineId?, stockItemId?, quantity?, neededBy?}`.
- `GET` lists newest first; a requester who does not approve sees only theirs (`mine` on each). `GET /{id}`.
- `POST /{id}/approve {approvalRequestId?, note?}`: above the threshold `409 PURCHASE_NEEDS_APPROVAL {threshold}`; `409 PURCHASE_APPROVAL_INVALID {reason: not_approved | below_amount | covers_another}`. Its requester is refused `409 PURCHASE_SELF_APPROVAL` unless naming the board's approval: another approver (a live deputy too) decides it.
- `POST /{id}/reject {reasonCode, note?}` (`purchaseReject`), `/cancel {reasonCode}` (`purchaseCancel`, the requester or an approver), `/fulfil {reference?}`. The wrong state is `409 PURCHASE_REQUEST_WRONG_STATUS {status}`.

## Notifications

`vendor_document.expiring` (vendorRef, paperKind, expiresOn), `maintenance_contract.payment_due` (contractRef, dueOn, amount), `purchase_request.submitted` (requestRef, amount), `purchase_request.decided` (requestRef, decision). All in the `maintenance` category; links: `/vendors/{id}`, `/contracts/{id}`, `/purchases/{id}`.
