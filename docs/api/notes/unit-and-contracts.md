# The resident's unit on paper: backend notes for the apps

What was built for a resident's papers:
- changing their own email, and asking for a name or phone change;
- proof of kinship on a family invite, and the `permits` and `documents` delegations;
- the unit's document vault;
- the compound's documents (bylaws, rights, guides);
- contracts and lease renewals;
- clearance certificates;
- the deposits the management holds.

A registrant's own page (`/rs`) and the clearance check (`/c`) are in `apps/public`, not in the app. The design decisions are in [ADR 0062](../../decisions/0062-unit-contracts-documents.md). The contract is `docs/api/openapi.v0.json` (regenerated), with the Postman collection.

Conventions, as everywhere in API v0:

- Every path is under `/api/v1`, with `Authorization: Bearer <access token>`.
- Errors are `{ "statusCode", "code", "message", "params"?, "fields"?: [{ "field", "code", "params"? }], "requestId", ... }`. Switch on `code` and `fields[].code`, never on `message`.
- **Step-up:** `POST /me/step-up`, then `/verify` with the emailed code, then the action within 10 minutes. One code opens one action. Without it the action answers `STEP_UP_REQUIRED`.
- Instants are ISO 8601 UTC. Dates (`YYYY-MM-DD`) are the **compound's** calendar days.
- Money is EGP strings with two decimals (`"1000.00"`).
- A document is read through its own `GET`, which answers `no-store` with a presigned `url` valid until `urlExpiresAt`. Open it at once; never cache it.
- Uploads are as everywhere (ADR 0029): `POST /files` with the purpose, `PUT` to the signed URL, `POST /files/{id}/finalize`. Then pass the `fileId`.

## Contents

1. [Own email](#own-email)
2. [Name and phone](#name-and-phone)
3. [Kinship proof and delegations](#kinship-proof-and-delegations)
4. [The unit's documents](#the-units-documents)
5. [The compound's documents](#the-compounds-documents)
6. [Contracts](#contracts)
7. [Renewing or leaving](#renewing-or-leaving)
8. [Clearance](#clearance)
9. [Deposits](#deposits)
10. [Notifications](#notifications)
11. [Errors](#errors)

## Own email

Residents and family members hold `profile.contact`.

1. Do a step-up.
2. Call `POST /me/contact/email {email}`, which answers `204`. A six-digit code goes to the **new** address.
3. Call `POST /me/contact/email/verify {email, code}`, which answers `204`. The account's email is now the new one, and the **old** address gets a notice that it changed.

A wrong or expired code is `403 CONTACT_CODE_INVALID`. Asking again sends a new code and ends the old one. The OTP rate limits apply (`429 RATE_LIMITED`).

## Name and phone

The name is the one on the ID the gate checks, and no SMS proves a phone yet. So the resident **asks**, and the management decides.

- `POST /me/identity-changes {field: "name" | "phone", value}` needs a step-up.
  - It answers `201` with an `IdentityChangeView`.
  - A name is 2–200 characters; a phone is E.164.
  - One request may be pending per account: `409 IDENTITY_CHANGE_PENDING`.
- `GET /me/identity-changes` returns the latest 10.
- `POST /me/identity-changes/{id}/cancel` withdraws a pending request. `409 IDENTITY_CHANGE_DECIDED` if it was already decided.

`IdentityChangeView`:

```json
{ "id": "…", "field": "phone", "status": "pending", "newValue": "+201001234567",
  "reasonCode": null, "createdAt": "…", "decidedAt": null }
```

- `status` is `pending`, `approved`, `rejected` or `cancelled`.
- `newValue` is shown only while pending; it is erased once decided.
- `reasonCode` on a rejection is `not_verified`, `does_not_match_documents` or `other`.
- The decision arrives as `account.identity_change_decided` (below).
- An approved phone follows the usual rules: a number another account holds is refused at approval.

## Kinship proof and delegations

**Kinship proof** is an optional `kinshipDocuments` array on `POST /units/{unitId}/household/invites`: at most 2 items, `[{fileId, kind}]`.
- `kind` is `birth_certificate`, `marriage_certificate`, `family_record` or `other`.
- Upload each file with the purpose `kinship_proof` (an image or a PDF, 10 MB).
- The compound's setting decides whether proof is allowed:
  - `off`: sending documents is `400 VALIDATION_FAILED` with `FIELD_NOT_ALLOWED`.
  - `optional`: proof may be sent or left out.
  - `required`: an invite without proof is `400 KINSHIP_PROOF_REQUIRED`, while family joins need approval.
- The inviter reads a document with `GET /household/invites/{id}/kinship-documents/{documentId}`.
- The files are deleted 30 days after the invite ends or its membership is decided.

**Delegations** (`POST /units/{unitId}/delegations`) have two new scopes:
- `permits`: the delegate asks for works, move and material-exit permits for the unit. Event permits already belong to members.
- `documents`: the delegate reads the vault's `occupants` documents, and adds documents at that level.

Money, contracts, renewals, clearances and deposits are never delegable.

## The unit's documents

The vault holds a unit's papers: warranties, manuals, the handover report, utility papers, insurance, inspection reports, and others.

- `GET /units/{unitId}/documents` returns `UnitDocumentView[]`.
- `GET /units/{unitId}/documents/{id}` returns the same view with `url` and `urlExpiresAt`.
- `POST /units/{unitId}/documents {kind, title, visibility, fileId, expiresOn?}` uses a file of purpose `unit_document`. It answers `201`.
- `POST /units/{unitId}/documents/{id}/delete` answers `204`. Only the uploader may delete.

```json
{ "id": "…", "unitId": "…", "kind": "warranty", "title": "Air conditioner",
  "visibility": "owners", "expiresOn": "2027-06-30", "holder": "occupancy",
  "mine": true, "createdAt": "…" }
```

- `kind` is `warranty` (then `expiresOn` is required), `manual`, `handover_report`, `utility`, `insurance`, `inspection_report` or `other`. `capacity_proof` appears too: it is the registrant's proof, filed at approval, and cannot be added.
- `visibility` decides who sees it:
  - `private`: the uploader's occupancy only.
  - `owners`: the unit's active owners. Only an owner may choose it.
  - `occupants`: everyone living in the unit, and `documents` delegates. A delegate may only add at this level.
- `holder` is `unit` when the management filed it, `occupancy` otherwise.
- `mine` says whether the caller's own occupancy holds it.
- After leaving, a resident still sees their own documents. They are deleted 90 days after the handover.
- At most 50 per unit: `409 UNIT_DOCUMENT_LIMIT`. A level the caller may not use is `403 UNIT_DOCUMENT_NOT_ALLOWED`.
- **The management never sees `private` or `owners` documents a resident filed.** It sees what it filed itself, and the registration proofs.
- A warranty warns whoever sees it 30 days before `expiresOn` (`unit_document.warranty_expiring`).

## The compound's documents

There are four kinds: `bylaws`, `occupant_rights`, `conduct_guide` and `moving_guide`. Residents and family members read them (`community.read`).

- `GET /compound-documents`: the latest version of each published kind, as `CompoundDocumentSummaryView[]`.
- `GET /compound-documents/versions?kind=bylaws`: that kind's versions, newest first.
- `GET /compound-documents/versions/{id}`: one version in full (`no-store`). It includes `bodyEn` and `bodyAr` (Markdown), `changesEn` and `changesAr` (what an amendment changes; null on version 1), `effectiveOn`, `boardPublicationId` (bylaws: the board's decision that adopted it), and `fileUrl` when a signed PDF is attached.

A version never changes; an amendment is a new version. A new version of the bylaws or the rights is announced to everyone (`compound_document.published`).

## Contracts

The management records contracts from the signed papers. The app shows them; it does not sign or create them.

- `GET /me/contracts` returns the caller's contracts as `ContractView[]`, including those of units they left.
- `GET /units/{unitId}/contracts/{id}` returns the same view with `fileUrl` (`no-store`).

```json
{ "id": "…", "reference": "CT-000012", "unitId": "…", "kind": "lease",
  "signedOn": "2026-01-10", "startsOn": "2026-02-01", "endsOn": "2027-01-31",
  "noticeDays": 60, "noticeBy": "2026-12-02", "status": "live", "renewsId": null,
  "partyOccupancyIds": ["…"], "hasFile": true, "createdAt": "…" }
```

- `kind` is `lease` or `ownership`. An ownership contract has no `endsOn`, `noticeDays` or `noticeBy`.
- `status`:
  - `live`: in force.
  - `renewed`: a newer lease (`renewsId` on it) replaced it.
  - `voided`: recorded by mistake.
- **Who sees what:**
  - A party always sees their contract.
  - The unit's owners also see its leases.
  - Tenants never see ownership contracts.
  - Members and delegates see none.
- An old contract's file may be gone: `hasFile: false`, five years after its end once nobody it binds lives there.
- `contract.expiring` arrives once, on the notice date, to the tenants and the owners.

## Renewing or leaving

`GET /units/{unitId}/contracts/{id}/end-options` is for a lease:

```json
{ "contract": { … },
  "renewal": { "askBy": "2026-12-02", "fee": "500.00", "request": null },
  "moveOut": { "noticeBy": "2026-12-02", "leaveBy": "2027-01-31", "fee": null } }
```

- **Fees.** A `fee` is the compound's published fee, or null when there is none. The management invoices it; nothing is paid here.
- **The request.** `renewal.request` is the latest renewal request (`RenewalView`), or null.
- **Ask.** `POST /units/{unitId}/contracts/{id}/renewal-requests` answers `201` with a `RenewalView`.
  - Only a tenant named on the live lease may ask: `403 CONTRACT_RENEWAL_NOT_ALLOWED`.
  - The lease must still be live, up to `endsOn`: `409 CONTRACT_NOT_LIVE`.
  - One request may be open at a time: `409 CONTRACT_RENEWAL_OPEN`.
- **Withdraw.** `POST /contract-renewals/{id}/withdraw` answers `200`. `409 CONTRACT_RENEWAL_CLOSED` once it is decided.
- `RenewalView.status` is `open`, `renewed`, `declined` or `withdrawn`:
  - `renewed` carries `renewedContractId`, the new lease.
  - `declined` carries `reasonCode`: `owner_declined`, `dues_outstanding`, `terms_not_agreed` or `other`.
- `contract.renewal_decided {outcome}` tells the tenant.

Moving out (the notice, the checklist and the handover) comes in R11a-2.

## Clearance

A clearance certificate states that the unit owed nothing to the compound at an instant. Any active occupant of the unit may ask; delegates may not.

- `POST /units/{unitId}/clearances` answers `201` with a `ClearanceView`, or `409 CLEARANCE_BALANCE_DUE` with `params.owed` (for example `"1000.00"`). Disputed invoices count as owed.
- `GET /units/{unitId}/clearances` returns the caller's certificates for the unit.
- `GET /clearances/{id}/certificate` returns the PDF (`application/pdf`, `no-store`), bilingual.

```json
{ "id": "…", "number": "CL-000003", "unitId": "…", "unitCode": "A-101",
  "asOf": "2026-10-27T14:03:11.000Z", "validUntil": "2026-11-26",
  "verifyCode": "q3V…22 chars" }
```

**Sharing it.** Whoever receives the certificate checks it at `<PUBLIC_APP_URL>/c#<verifyCode>`, or by typing the code at `/c`. The check shows the compound, the number, the unit's code, the dates and whether it is still valid. It never shows a name. The app may share that link.

## Deposits

These are deposits **the management** holds: finishing works, a move, the maintenance fund. A lease deposit paid to a landlord is not here.

- `GET /me/deposits` returns `DepositView[]`.

```json
{ "id": "…", "number": "DP-000004", "unitId": "…", "occupancyId": "…",
  "kind": "finishing_works", "amount": "3000.00", "held": "3000.00",
  "method": "bank_transfer", "receivedOn": "2026-05-02", "refundRequested": false,
  "events": [{ "kind": "refund_requested", "amount": null, "reasonCode": null, "at": "…" }] }
```

- `POST /deposits/{id}/refund-request` answers `200` with the deposit.
  - `409 DEPOSIT_REFUND_ASKED` if a request is already open.
  - `409 DEPOSIT_NOTHING_HELD` if nothing is left.
- `POST /deposits/{id}/refund-request/withdraw` answers `200`. `409 DEPOSIT_REFUND_NOT_ASKED` if there is no open request.
- The management settles. `events` then shows:
  - `refunded` with an amount;
  - `deducted` with an amount and a `reasonCode`: `unpaid_dues`, `damage`, `cleaning`, `works_unfinished` or `other`;
  - `forfeited`.
- A deduction for unpaid dues pays the unit's invoices, as a payment of method `deposit_offset`.
- Only the depositor's own account asks; delegates cannot.
- An account cannot be deleted while a deposit still holds money (`deposit_held` among the blockers).

## Notifications

| Kind | Params | To |
|---|---|---|
| `account.identity_change_decided` | `field`, `outcome` (`approved`, `rejected`) | the requester |
| `compound_document.published` | `subject` (the kind), `versionNo` | everyone, for the bylaws and the rights |
| `contract.expiring` | `endsOn`, `noticeBy` | the lease's tenants and the unit's owners |
| `contract.renewal_decided` | `outcome` (`renewed`, `declined`) | the requester |
| `unit_document.warranty_expiring` | `expiresOn` | whoever the warranty's visibility reaches (its occupancy, the owners, or every occupant); nobody once its occupancy ended |

## Errors

New codes:
- **Own email:** `CONTACT_CODE_INVALID`.
- **Name and phone:** `IDENTITY_CHANGE_PENDING`, `IDENTITY_CHANGE_DECIDED`, `IDENTITY_CHANGE_NOT_FOUND`.
- **Kinship proof:** `KINSHIP_PROOF_REQUIRED`, `KINSHIP_DOCUMENT_NOT_FOUND`.
- **Documents:** `UNIT_DOCUMENT_LIMIT`, `UNIT_DOCUMENT_NOT_ALLOWED`, `UNIT_DOCUMENT_NOT_FOUND`, `COMPOUND_DOCUMENT_NOT_FOUND`.
- **Contracts:** `CONTRACT_NOT_FOUND`, `CONTRACT_NOT_LIVE`, `CONTRACT_RENEWAL_NOT_ALLOWED`, `CONTRACT_RENEWAL_OPEN`, `CONTRACT_RENEWAL_CLOSED`, `CONTRACT_RENEWAL_NOT_FOUND`.
- **Clearance:** `CLEARANCE_BALANCE_DUE`, `CLEARANCE_NOT_FOUND`.
- **Deposits:** `DEPOSIT_NOT_FOUND`, `DEPOSIT_REFUND_ASKED`, `DEPOSIT_REFUND_NOT_ASKED`, `DEPOSIT_NOTHING_HELD`, `DEPOSIT_EXCEEDS_HELD`.

The management's own codes (`CONTRACT_LEASE_LIVE`, `CONTRACT_PARTY_INVALID`, `REGISTRATION_CORRECTION_PENDING`) and the public pages' (`REGISTRATION_*`) never reach the app.
