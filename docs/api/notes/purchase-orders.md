# Purchase orders, goods receipts and the three-way match: backend notes for the dashboards

What was built (ADR 0094):
- purchase orders, raised directly, from an approved purchase request or from an awarded tender, approved by someone else, amended by revisions, sent as a PDF and acknowledged by the vendor's contractors;
- goods and service receipts in parts, with the quantity accepted and rejected, photos, and the stock receipt of a stock line;
- the three-way match of a vendor's invoice against its order and what was accepted, with the compound's tolerances and an audited override;
- three reports on the reports platform.

The design decisions are in [ADR 0094](../../decisions/0094-purchase-orders-receipts-and-three-way-match.md). The contract is `docs/api/openapi.v0.json` (regenerated), with the Postman collection.

Conventions, as everywhere in API v0: every path is under `/api/v1`, amounts are decimal strings in EGP with two places, quantities three places, days (`YYYY-MM-DD`) are the compound's. **Every route here answers `Cache-Control: no-store`** (a receipt carries signed photo links).

## Who does what

- `purchase_orders.raise` (the manager, the accountant, the maintenance supervisor): raise, amend, take back a revision, send, cancel. It also reads the budgets (`GET /staff/finance/budgets`, `GET /staff/finance/budgets/{id}`) to pick the order's line, and changes nothing in them.
- `purchases.approve` (the manager): approve or turn down an order or a revision; call off a waiting order. **Never the order's raiser, or the asker of the revision, even under the board's approval** (`409 PURCHASE_ORDER_SELF_APPROVAL`).
- `purchase_orders.receive` (the manager, the maintenance supervisor): receive. The order's raiser or its request's requester may confirm its **service** lines alone.
- Reads of orders: any of `purchase_orders.raise`, `purchase_orders.receive`, `purchases.approve`, `finance.payables`, `finance.payables_approve`.
- `finance.payables` / `finance.payables_approve`: record the invoice; read the match and the settings; the approver approves the invoice and keeps the settings.
- `finance.match_override` (the manager): let a mismatch through, never on an invoice the caller recorded (`409 MATCH_SELF_OVERRIDE`).
- `purchase_orders.acknowledge` (the contractor role): the vendor's side.

## Orders

- `GET /staff/purchase-orders` (`status`, `vendorId`, `purchaseRequestId`, `tenderId`, `waiting=true` = a first approval or a revision waits; paged), `GET …/{id}` → `PurchaseOrderView`: the revision in force (`revision`, `total`, lines with `accepted`, `rejected`, `invoiced`), `pendingRevision`, `revisions` (newest first, each with its proposed lines), `receipts`, `invoices`, `committed` (what its commitment still keeps), `sentAt/sentRevision`, `acknowledgedAt/acknowledgedRevision`, `status` (`requested | approved | rejected | cancelled | closed`) and `closeReason` (`completed | remainder_cancelled`).
- `POST /staff/purchase-orders` (idempotent): `{ vendorId?, budgetLineId?, purchaseRequestId?, tenderId?, deliveryOn, note?, lines[] }`. A line: `{ kind: stock | goods | service, stockItemId? (stock; its unit is the line's), description?, quantity, unit?, unitPrice (net), taxCode? (zero | exempt | vat_14), withholdingCategory? }`. From a request the vendor and line default to its; from a tender the vendor is the award's. `409 PURCHASE_ORDER_SOURCE_INVALID {reason}`: `request_not_approved`, `already_ordered`, `vendor_mismatch`, `tender_not_awarded`, `contract_scheduled`, `award_exceeded {awarded, ordered}`.
- `POST …/{id}/approve {approvalRequestId?, note?}`: up to the manager's limit on the gross, above it the board's approved major contract (`PURCHASE_ORDER_NEEDS_APPROVAL {threshold}`, `PURCHASE_ORDER_APPROVAL_INVALID {reason}`). Keeps the line's money as the order's commitment (`BUDGET_LINE_INSUFFICIENT {available}`); an order from a request takes the request's commitment over and marks the request fulfilled. `…/reject {reasonCode: purchaseOrderReject, note?}`.
- `POST …/{id}/amend {reasonCode: purchaseOrderAmend, budgetLineId?, deliveryOn?, note?, lines[]}`: the whole order as amended (a line with its `id` changes, one without is new, one left out is dropped); a new revision; one at a time (`PURCHASE_ORDER_REVISION_PENDING`); no line below what was accepted or invoiced, none dropped that has a receipt or an invoice (`PURCHASE_ORDER_LINE_BELOW_USED {min}`). `…/withdraw-revision` by its asker.
- `POST …/{id}/cancel {reasonCode: purchaseOrderCancel}`: a waiting order is called off; an approved one has the rest cancelled and closes, its commitment keeping the value of what arrived and is not invoiced.
- `POST …/{id}/send`: records the revision sent and tells the vendor's contractors. `GET …/{id}/pdf`: the revision in force.

## Receipts

- `POST /staff/purchase-orders/{id}/receipts` (idempotent): `{ receivedOn, storeId?, deliveryNote?, note?, photoFileIds?[], lines: [{ purchaseOrderLineId, accepted, rejected?, rejectReason? (goodsRejection), note? }] }` → `GoodsReceiptView` (`GR-` reference, lines, photos with signed URLs). `storeId` is required when a stock line is accepted and refused otherwise; photos are uploads of purpose `goods_receipt_photo` (images, 10 MB). `409 GOODS_RECEIPT_EXCEEDS_ORDER {lineId, max}`; `409 PURCHASE_ORDER_STATE` unless the order is approved.

## Invoices and the match

- `POST /staff/finance/vendor-invoices` takes `purchaseOrderId` instead of `contractId` / `purchaseRequestId` (exactly one of the three). Its lines name the order's lines: `{ description, purchaseOrderLineId, quantity, unitPrice, taxCode? }` (the amount is the product, and is refused), or carry an `amount` and name none (an extra line). `VendorInvoiceView` gains `purchaseOrderId` and the lines' `purchaseOrderLineId`, `quantity`, `unitPrice`; `GET …/vendor-invoices?purchaseOrderId=`. A purchase request an order took over is invoiced through the order (`VENDOR_INVOICE_SOURCE_INVALID {reason: ordered}`).
- `GET /staff/finance/vendor-invoices/{id}/match` → `InvoiceMatchView`: `status` (`none | matched | blocked | overridden`), `issues[]` (`quantity_not_received | quantity_over_order | price_over | extra_line`, with `position`, `quantity`, `amount`), the lines beside the order's (ordered, accepted, billed before, prices, variance), `priceVariance` (signed), `tolerance`, `override`. Read live: a receipt or a corrected invoice changes it.
- Approving a blocked invoice: `409 INVOICE_MATCH_BLOCKED {issues}` (a count). Resolve it by a receipt, by calling the invoice off with the reason `corrected` and recording the corrected one, or `POST …/vendor-invoices/{id}/match/override {reasonCode: matchOverride, note?}` (`finance.match_override`, once, while it waits, not the recorder; `409 INVOICE_MATCH_NOT_BLOCKED` when there is nothing to let through).
- `GET|PATCH /staff/finance/purchase-order-settings`: `{ poRequiredAbove (EGP or null = never), pricePct (2.00), quantityPct (0.00), amount (100.00) }`. Above `poRequiredAbove` an invoice with no contract needs an order (`409 VENDOR_INVOICE_PO_REQUIRED {above}`).

## The vendor's contractors

`GET /contractor/purchase-orders`, `…/{id}`, `…/{id}/pdf`, `POST …/{id}/acknowledge` (`purchase_orders.acknowledge`): only the orders sent to the contractor's company; `ContractorPurchaseOrderView` shows what was ordered (lines, prices, delivery day, totals, whether the revision sent was acknowledged), nothing of the budget or the receipts. `POST /contractor/invoices` accepts a `purchaseOrderId` of its company's.

## Reports, inbox, notices

- Reports (`finance.payables`): `po_open`, `po_received_not_invoiced`, `po_match_exceptions`; read as of the period's last day.
- Inbox type `purchase_order` (an order or revision waiting; `purchases.approve`; 72 h). Notices `purchase_order.submitted | decided | sent`, never an amount.
- Commitments (`GET /staff/finance/commitments`) and the payment schedule have the source `purchase_order` and `purchaseOrderId`.

## Errors

`PURCHASE_ORDER_NOT_FOUND`, `PURCHASE_ORDER_STATE {status}`, `PURCHASE_ORDER_SELF_APPROVAL`, `PURCHASE_ORDER_NEEDS_APPROVAL {threshold}`, `PURCHASE_ORDER_APPROVAL_INVALID {reason}`, `PURCHASE_ORDER_SOURCE_INVALID {reason}`, `PURCHASE_ORDER_REVISION_PENDING {revision}`, `PURCHASE_ORDER_LINE_BELOW_USED {lineId, min}`, `GOODS_RECEIPT_EXCEEDS_ORDER {lineId, max}`, `GOODS_RECEIPT_NOT_FOUND`, `VENDOR_INVOICE_PO_REQUIRED {above}`, `INVOICE_MATCH_BLOCKED {issues}`, `INVOICE_MATCH_NOT_BLOCKED`, `MATCH_SELF_OVERRIDE`.
