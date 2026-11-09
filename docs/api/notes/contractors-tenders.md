# The contractor portal and tenders (ADR 0088)

## A vendor's contractors

| Route                                      | Who                      | What                                                                                                                              |
| ------------------------------------------ | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `GET/POST /staff/vendors/{id}/contractors` | `vendors.manage`         | The vendor's contractor accounts; invite one (as staff: full name, ID, phone, email). A suspended vendor: `409 VENDOR_SUSPENDED`. |
| `GET /contractor/vendor`                   | a contractor             | Its company.                                                                                                                      |
| `GET /contractor/contracts`                | `vendor_invoices.submit` | Its company's contracts and their schedules.                                                                                      |

A contractor signs in as staff do; its token's `typ` is `contractor`. It reaches nothing of the compound a technician on its job does not.

## Dispatch to a vendor

| Route                                                     | Who                     | What                                                                                                                                                                |
| --------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /maintenance/tickets/{id}/vendor-dispatch`          | `tickets.dispatch`      | `{vendorId, note?}`: a queued ticket with no technician; `409 TICKET_OFFERED_TO_VENDOR` when offered already; `400 vendorId INVALID_VALUE {reason: no_contractor}`. |
| `POST /maintenance/tickets/{id}/vendor-dispatch/withdraw` | `tickets.dispatch`      | `{reasonCode}` from `vendorDispatchWithdraw`; `409 VENDOR_DISPATCH_STATE` once taken.                                                                               |
| `GET /maintenance/tickets/{id}/vendor-dispatches`         | `tickets.dispatch`      | Its offers, oldest first.                                                                                                                                           |
| `GET /contractor/dispatches?open=true`                    | `tickets.contract_work` | The offers to its company: number, category, priority, place, note.                                                                                                 |
| `POST /contractor/dispatches/{id}/accept`                 | `tickets.contract_work` | `{ticketId}`: now under `/technician/tickets/{id}`. Taken already: `409 VENDOR_DISPATCH_STATE {status}`.                                                            |
| `POST /contractor/dispatches/{id}/decline`                | `tickets.contract_work` | `{reasonCode}` from `vendorDispatchDecline`.                                                                                                                        |

Once taken, the ticket's own routes are the technician's: `/technician/tickets/{id}` and its `start`, `hold`, `complete`, `decline`, photos, messages, visits, checklist, permits and safety, quote suggestions, SOS. Assigning an offered ticket: `409 TICKET_OFFERED_TO_VENDOR`.

## Tenders

| Route                                                                    | Who                                | What                                                                                                                                                                 |
| ------------------------------------------------------------------------ | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /staff/tenders?status` · `GET /staff/tenders/{id}`                  | `tenders.manage` or `tenders.open` | The detail is no-store (its documents' URLs); the list is not (no URL, token or person). Bids: who and when; `sealed: true`, amount and terms null until opened.     |
| `POST /staff/tenders` · `PATCH /staff/tenders/{id}`                      | `tenders.manage`                   | A draft (idempotent); its terms while a draft (`409 TENDER_STATE` after).                                                                                            |
| `POST /staff/tenders/{id}/publish` · `/deadline` · `/cancel`             | `tenders.manage`                   | Published (deadline an hour to a year ahead); a later deadline before it passes (`409 TENDER_CLOSED` after); called off with `tenderCancel`.                         |
| `POST /staff/tenders/{id}/documents` · `DELETE …/documents/{documentId}` | `tenders.manage`                   | A `tender_document` upload; 20 live (`409 TENDER_DOCUMENT_LIMIT`).                                                                                                   |
| `POST /staff/tenders/{id}/invitations`                                   | `tenders.manage`                   | `{vendorId}` (`409 TENDER_ALREADY_INVITED`) or `{companyName, contactEmail?}`: `{invitation, url, expiresAt}`, the link shown once.                                  |
| `POST /staff/tenders/{id}/invitations/{invitationId}/link` · `/revoke`   | `tenders.manage`                   | A new link (the old one stops); revoked (its link opens nothing; its live bid withdrawn while bids are taken).                                                       |
| `POST /staff/tenders/{id}/opening`                                       | `tenders.open`                     | After the deadline (`409 TENDER_NOT_DUE`): first call `opening`, a different person's `opened` (`409 TENDER_OPENING_SAME_PERSON`).                                   |
| `POST /staff/tenders/{id}/award`                                         | `tenders.manage`                   | `{bidId, code, startsOn, endsOn, approvalRequestId?}`: the contract is signed; above the limit `409 CONTRACT_NEEDS_APPROVAL` / `CONTRACT_APPROVAL_INVALID {reason}`. |
| `GET /contractor/tenders` · `GET /contractor/tenders/{id}`               | `tenders.bid`                      | The tenders its company is invited to; not invited: `404 TENDER_NOT_FOUND`.                                                                                          |
| `POST /contractor/tenders/{id}/bid` · `/bid/withdraw`                    | `tenders.bid`                      | `{amount, durationDays?, note?, fileId?}` (a `tender_bid` upload); one live (`409 TENDER_BID_EXISTS {bidId}`); late: `409 TENDER_CLOSED`.                            |
| `POST /public/tender-bids/lookup` · `/bid` · `/withdraw`                 | the link                           | `{token, …}` in the body; anything that opens nothing: `404 TENDER_LINK_NOT_FOUND`; 30 calls a minute per IP, 20 per link (`429`).                                   |

An invitee's view: `status` is `open`, `closed` (past the deadline), `awarded` or `cancelled`; `bid.amount` only once opened; `outcome` `awarded | not_awarded | cancelled`.

## A contractor's invoices

| Route                       | Who                      | What                                                                                                                                                                                                                                                             |
| --------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /contractor/invoices` | `vendor_invoices.submit` | ADR 0089's record by the `contractor` channel: `{vendorNumber, issuedOn, dueOn, contractId \| purchaseRequestId, contractPaymentId?, invoiceFileId, lines, note?}`; another vendor's contract or purchase: its 404. Then approved and paid by the office as any. |
| `GET /contractor/invoices`  | `vendor_invoices.submit` | Its company's, by this channel, newest first.                                                                                                                                                                                                                    |
