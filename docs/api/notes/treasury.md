# Treasury and custody: backend notes for the dashboards

What was built for the money's side after it is collected (ADR 0085):

- the compound's bank and cash accounts, as registers;
- collectors' and cashiers' custody, its hand-in, variance and investigation;
- the cheque register, post-dated cheques included;
- bank statements imported and matched.

The design decisions are in [ADR 0085](../../decisions/0085-treasury-and-custody.md). The contract is `docs/api/openapi.v0.json` (regenerated), with the Postman collection.

Conventions, as everywhere in API v0: every path is under `/api/v1`, lists are `{ "data": [...], "nextCursor" }`, errors carry `code` and `fields[].code`, creates take an optional `Idempotency-Key`. Amounts are decimal strings with two places; local days (`YYYY-MM-DD`) are the compound's.

## Accounts (`finance.treasury`)

| route                                                 |                                                                                                                                                                                             |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /staff/finance/cash-accounts?includeRetired=`    | `CashAccountView`: kind, name, bank and last four digits, `balance` (the sum of its movements), `unmatchedLines`, `pendingCheques`                                                          |
| `POST /staff/finance/cash-accounts`                   | `{ kind: bank                                                                                                                                                                               | cash, name, bankName?, numberLast4?, openingBalance?, openedOn }`; a cash box takes no bank fields; names unique among live accounts (`409 DUPLICATE_RESOURCE`on`name`) |
| `GET`/`PATCH /staff/finance/cash-accounts/{id}`       | name, bank, last four                                                                                                                                                                       |
| `POST /staff/finance/cash-accounts/{id}/retire`       | at a zero balance, no cheque pending: else `409 CASH_ACCOUNT_NOT_EMPTY {balance, pendingCheques}`                                                                                           |
| `POST /staff/finance/cash-accounts/{id}/adjustments`  | `{ amount (signed), reasonCode (cashAdjust), onDay }`                                                                                                                                       |
| `POST /staff/finance/cash-transfers`                  | `{ fromAccountId, toAccountId, amount, onDay }` → `CashTransferView { id, legs }`                                                                                                           |
| `GET /staff/finance/cash-movements?accountId&from&to` | `CashMovementView`: kind (`opening`, `handin`, `recovery`, `transfer`, `cheque`, `statement_payment`, `adjustment`, `reversal`, `payout`, `tax_payment`), signed amount, day, source ids (`payoutId`, `taxPaymentId`), who |

A cash box never goes below zero (`409 CASH_ACCOUNT_INSUFFICIENT {balance}`); a retired account takes nothing (`CASH_ACCOUNT_RETIRED`); a hand-in needs a cash box and a deposit or a statement a bank (`409 CASH_ACCOUNT_WRONG_KIND {kind}`, the kind needed). A movement's day is today or up to 31 days back.

## Custody

| route                                                             | who                                                 |                                                                                        |
| ----------------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `GET /staff/finance/custody`                                      | `finance.payments`                                  | each custodian: `openCount`, `expected`, `oldestAt`, `ageHours`, `unresolvedVariances` |
| `GET /staff/finance/custody/{accountId}`                          | `finance.payments`                                  | `CustodyView`: the open payments (oldest 500) and the latest 20 hand-ins               |
| `POST /staff/finance/custody/{accountId}/handins`                 | `finance.payments`, not the custodian               | `{ cashAccountId, expected, counted, varianceReason? }` → `CustodyHandinDetailView`    |
| `GET /staff/finance/custody-handins?status&custodianId`, `…/{id}` | `finance.payments`                                  |                                                                                        |
| `POST /staff/finance/custody-handins/{id}/resolve`                | `finance.custody`                                   | `{ reasonCode (custodyOutcome), recoveredAmount? }`                                    |
| `POST /staff/finance/custody-handins/{id}/investigation`          | `finance.custody`                                   | `{ ownerId, dueOn }` (within 60 days)                                                  |
| `GET /staff/finance/custody-investigations?status`                | `finance.custody` (all) or `finance.payments` (own) | `overdue` flag                                                                         |
| `POST /staff/finance/custody-investigations/{id}/decide`          | its owner, or `finance.custody`                     | `{ reasonCode, recoveredAmount? }`                                                     |
| `GET /collector/custody`                                          | `finance.collect`                                   | the collector's own `CustodyView`                                                      |

- `expected` is what the receiver was shown: anything else is `409 CUSTODY_CHANGED {expected}` (refetch and count again); nothing open, `409 CUSTODY_EMPTY`; the custodian themself, `403 CUSTODY_CONFLICT`.
- `varianceReason` (`custodyVariance`) when `counted` differs, and only then. A variance hand-in is `status: variance` until settled (`resolved`); a balanced one is `balanced`.
- `recoveredAmount` only with `recovered`, only of a shortage, at most it (`INVALID_VALUE {max}`). `CUSTODY_INVESTIGATION_OPEN {investigationId}` when resolving a hand-in under investigation; `CUSTODY_HANDIN_NOT_OPEN {status}`; `CUSTODY_INVESTIGATION_DECIDED`.
- The inbox: `cash_custody` (24 h) and `custody_variance` (72 h). Notices: `finance.custody_variance` (critical, `handinNumber`), `finance.custody_investigation_assigned` (`handinNumber`, `dueOn`).

## Cheques (`finance.payments`)

| route                                      |                                                                                                                                                                                                                |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /staff/units/{unitId}/cheques`       | `{ number, bankName?, amount, dueOn, receivedOn, invoiceIds? }` → `ChequeView`; dated today or earlier it pays at once (`paymentId`); post-dated it is held (`postDated`, `paymentId: null`), names no invoice |
| `GET /staff/finance/cheques?status&unitId` |                                                                                                                                                                                                                |
| `POST /staff/finance/cheques/{id}/deposit` | `{ accountId }` (a bank); from `dueOn` (`409 CHEQUE_NOT_DUE {dueOn}`); a held cheque pays now                                                                                                                  |
| `POST /staff/finance/cheques/{id}/clear`   | into the bank account                                                                                                                                                                                          |
| `POST /staff/finance/cheques/{id}/bounce`  | `{ reasonCode (chequeBounce) }`: its payment reversed (`paymentReversed`)                                                                                                                                      |
| `POST /staff/finance/cheques/{id}/return`  | `{ reasonCode (chequeReturn) }`: before deposit; a payment it made reversed                                                                                                                                    |

A step out of order is `409 CHEQUE_STATE {status}`. An office payment by cheque (`POST /staff/units/{unitId}/payments`) is in the register too. Notices: `cheque.due` (`dueOn`) to `finance.payments`; `cheque.bounced` to the unit's money viewers (target: the payment).

## Bank statements (`finance.treasury`)

| route                                                        |                                                                                                                                                                               |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /staff/finance/cash-accounts/{id}/statement-imports`   | `{ fileId }` (a `data_import` CSV): the dry run → `StatementImportView` (`status` valid or invalid, `rowCount`, `newCount`, `duplicateCount`, `errors[] {line, field, code}`) |
| `GET /staff/finance/statement-imports?accountId`, `…/{id}`   |                                                                                                                                                                               |
| `POST /staff/finance/statement-imports/{id}/apply`           | once, within a day: `importedCount`, `matchedCount`                                                                                                                           |
| `GET /staff/finance/statement-lines?accountId&status=matched | unmatched`                                                                                                                                                                    | `StatementLineView` with its live `match` |
| `GET /staff/finance/statement-lines/{id}/candidates`         | `MatchCandidateView`: payments, cheques, transfer legs of the same amount within 30 days                                                                                      |
| `POST /staff/finance/statement-lines/{id}/match`             | `{ kind: payment                                                                                                                                                              | cheque                                    | transfer, targetId }`or`{ kind: adjustment, reasonCode }` |
| `POST /staff/finance/statement-matches/{id}/undo`            | once (`STATEMENT_MATCH_UNDONE`)                                                                                                                                               |

The CSV: a header with `date`, `amount` (signed), and optional `reference`, `description`; UTF-8, a byte-order mark allowed, at most 2000 lines and 1 MB. `422 STATEMENT_IMPORT_UNREADABLE {problem, line}`; `409 STATEMENT_IMPORT_NOT_VALID {status}`; `409 STATEMENT_LINE_MATCHED {matchId}`; `409 MATCH_TARGET_TAKEN {lineId}`; `409 MATCH_TARGET_INVALID {why: amount|account|state}`; `404 MATCH_TARGET_NOT_FOUND`.
