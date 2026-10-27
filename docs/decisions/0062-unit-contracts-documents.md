# 0062 — The resident's unit on paper: a registrant's proofs and status link, corrections; their own email, and name or phone changes the management decides; kinship proof and a `permits` delegation; the unit's document vault; the compound's versioned documents; contracts and renewals; clearance certificates and the deposits the management holds

**Status:** Accepted · Phase R11a-1 · The resident's unit

## Context

The audit of 10-21 found the paper side of a resident's unit unbuilt. A registrant could not prove their place in the unit or follow their request. Residents could not change their own contact details. A family invite carried no proof of kinship. Nobody could keep a unit's papers. The compound had no bylaws on record. Leases and their ends were missing, and so was a certificate that a unit owes nothing.

ADR 0049 deferred "move-in and move-out with contracts (R8)". R8 was never recorded as blocked: no ADR, index row or handoff holds its questions. They are answered here and in R11a-2:

| # | Question (source) | Answer |
|---|---|---|
| R8-1 | A move permit has no direction; moving is not tied to an occupancy (0049) | R11a-2: moves with a direction, tied to the occupancy |
| R8-2 | Paying for a permit, or a deposit (`notes/permits.md`) | Deposits are recorded as money the management holds (below). Permits have no fees: the management invoices by hand |
| R8-3 | Who approves the handover despite dues | R11a-2: the handover is never blocked. Keys are physical, and the manager records a reason code |
| R8-4 | Correcting a registration document (0009 #12, 0024) | Built here |
| R8-5 | A retention-policy table (0009 #12) | Stays open. This ADR fixes a period per record (below) |
| R8-6 | Units with several tenants (0009 #12) | Avoided. A lease may name several tenant occupancies; there is still no multi-tenant unit flag |
| R8-7 | `endLease` and `removeOccupant` are display-only flags | R11a-2: `endLease` becomes the move-out notice |
| R8-8 | Former residents cannot see their old unit's papers | A contract stays readable to its party after they leave, and so do their own vault documents (below) |

**Out of scope here.** These are R11a-2, under ADR 0063:
- moves and their checklists;
- the closed-unit fixes and proxies;
- inspection requests;
- works completion.

Also out of scope: rent-versus-own calculators. They are client arithmetic on numbers the user types, and need no backend.

**The model is the earlier cards':**
- rules are decided under a lock, by the database's clock (`dbNow`), with days on the compound's local calendar;
- rows move forward only, guarded by triggers;
- codes replace free text wherever someone else will read it;
- every new table is under RLS, forced, with composite foreign keys;
- the audit, notifications, outbox and idempotency records hold ids, codes and counts only.

## Decisions

### Server-side PDFs (`src/core/pdf`)

**pdfkit and bidi-js, with the fonts vendored.** The fonts are Noto Naskh Arabic and Noto Sans, regular and bold, under the OFL (`assets/fonts`).
- bidi-js orders each line, but it does not join letters; fontkit's shaping (inside pdfkit) does that.
- Each word is drawn on its own, in its script's font, in visual order. The space between Arabic words is kept, and Latin text and digits inside Arabic read left to right.
- A test renders a bilingual certificate with Arabic names, numbers and mixed text, and rasterises it outside `src` (`pnpm test:pdf-sample`, `pdftoppm`). The image was checked once by eye.

**A certificate is a record, not a file.**
- The PDF is drawn on demand from the immutable row and its `template` (`certificate.v2`; v1 never left this branch). The unit's code and its building are separate rows, since one value mixing them reorders around the digits; every amount is written one way, `0.00 EGP`, and `جنيه` appears only inside the Arabic sentence.
- The creation date is the record's instant, so the same row always gives the same bytes. A spec pins the template's output hash.
- A new layout is a new template version; old versions stay in code.
- Nothing is stored, so nothing is purged or erased.

### A registrant's proofs and status link (amends ADR 0024)

**The link.** A registrant has no account, so they follow their request through a link: `<PUBLIC_APP_URL>/rs#<token>`. (`/r` is the registration form.)
- The token is an HMAC of the tenant, the request and its `status_link_seq`. It is never stored.
- The global pointer `registration_status_links` keeps an HMAC of the token, one row per request.
- `complete` answers exactly as before, so it reveals nothing. The link is **emailed** to the verified address (`community.registration_received`), rendered at send time.
- A correction issues a new link and the old one stops working. Registering again for the same email resets the request to `pending` and sends a new link.
- **The link dies with the decision.** Approving, rejecting or expiring a request deletes the pointer in the same transaction. Every later call gets the one 404, and the decision email tells the outcome.

**Public routes.** All are POST with the token in the body and `@PublicPageHeaders`:
- `/public/registrations/status`
- `/public/registrations/uploads`
- `/public/registrations/documents/{id}/finalize`
- `/public/registrations/documents/{id}/remove`
- `/public/registrations/resubmit`

How they are guarded:
- **Rate limits** are per IP (`REGISTRATION_STATUS_RATE_LIMIT_PER_IP`, 30 a minute) and per token (`…_PER_TOKEN`, 20), applied before any read.
- **Every miss is the same** `404 REGISTRATION_STATUS_NOT_FOUND`: unknown, decided, replaced, or a suspended compound.
- **Lock.** The request row is locked FOR UPDATE, and then its `status_link_seq` must still match the token's.

**Documents** (`registration_documents`; kinds `ownership_proof`, `lease_proof`, `other_proof`):
- **Limits.** At most 3 live, uploads not yet finalized included. Each is an image or a PDF of 10 MB at most.
- **Type check.** The type is signed into the upload and sniffed at finalize.
- **Files with no owner.** The registrant has no account, so the file row is created with `record_upload` and no owner. `files_owned_or_attached` now accepts it. Finalize attaches it.

**Correction.**
- `POST /registrations/{id}/request-correction {codes}` needs `residents.manage`.
- It takes codes only, from `document_unreadable`, `document_missing`, `document_mismatch` and `details_mismatch`. No text reaches the registrant's channel.
- The request moves to `needs_correction` and the registrant is emailed a new link (`community.registration_correction`).
- `resubmit` needs one finalized document and moves the request back to `pending`.
- The 30-day expiry counts from the latest of creation, correction and resubmission.

**At the decision:**
- The document files are marked deleted (`retention`) and their objects are purged after commit.
- On approval, the ready proofs are first copied into the unit's vault as `capacity_proof` documents, private to the new occupancy.

### Self contact change; name and phone changes the management decides

**Email** (`profile.contact`, a new resident and family permission):
1. `POST /me/contact/email` spends a step-up and sends a code (OTP purpose `contact_change`) to the **new** address. The code is bound to the account and the address, and can never log in.
2. `POST /me/contact/email/verify` locks the account FOR UPDATE and writes the address through `AccountWriter.updateContact`.

The **old** address is then told (`account.email_changed`, no parameters). A wrong code gets `403 CONTACT_CODE_INVALID`. The OTP rate limits apply, per account.

**Name and phone are requests** (`account_identity_changes`, field `name|phone`):
- **Why a request.** The gate checks the name against the ID, and no SMS channel proves a phone yet.
- **Rules.** One pending per account. The new value is held only while pending, and is erased when the request is decided, cancelled, or the account is erased.
- **Routes.** Residents use `GET/POST /me/identity-changes` (with step-up) and `…/{id}/cancel`. Managers (`residents.manage`) use `GET /identity-changes`, `…/approve` and `…/reject` with a code: `not_verified`, `does_not_match_documents`, `other`.
- **Approval** writes through `updateContact`, so a phone keeps its uniqueness and `PHONE_RELEASED` rules.
- **Lock order:** the account FOR UPDATE, then the request.

### Kinship proof and the `permits` and `documents` delegations (amends ADR 0016)

**Kinship proof.**
- The setting `family_kinship_proof` takes `off`, `optional` (the default) or `required`.
- `required` applies only while family joins need approval (`KINSHIP_PROOF_REQUIRED`).
- The primary attaches at most 2 documents to an invite (`household_invite_documents`): birth certificate, marriage certificate, family record, or other.
- **Who reads them:** the approvers (`household.approve`, on the pending member) and the inviter (on the invite).
- **Retention.** The invite's documents are released when it ends, or when its membership is decided. Their files are deleted 30 days later (`household.kinship_proof_retention`).

**Delegation scopes.** Two new ones:
- **`permits`:** works, move and material-exit permits. Event permits are excluded; members already have those.
- **`documents`:** the vault at the `occupants` level, to read and add.

These stay never delegable: money, contracts, renewals, clearances, deposits, governance, ownership, closed mode and delegations. Paying can already be granted to a member through the `finance` grant, with a cap. A delegate's permit records `onBehalfOf`.

### The unit's document vault

**`unit_documents`.**
- **Kinds:** `warranty` (with `expires_on`), `manual`, `handover_report`, `utility`, `insurance`, `capacity_proof`, `inspection_report`, `other`.
- **Other columns:** a title of at most 120 characters, a file, and the owning occupancy (null when the management files it).
- **Visibility:** `private`, `owners` or `occupants`.
- **Limit:** at most 50 live per unit.
- A trigger lets only `deleted_at` and `expiry_notified_at` be set, once each. A row may be deleted only after `deleted_at`.

**Who sees what:**
- `private`: its occupancy only.
- `owners`: the active owner occupancies.
- `occupants`: every active occupancy, and the `documents` delegates.
- A caller always sees their own occupancies' documents, even after leaving.
- The management (`unit_documents.manage`) sees only what it filed, plus `capacity_proof`. **It never sees a resident's own uploads.**

**Adding and deleting:**
- `owners` needs an owner. A delegate adds at `occupants` only. Staff add at `owners` or `occupants`. Nobody adds a `capacity_proof` directly.
- The uploader deletes their own; the management deletes its own.

**Sweeps:**
- `unit_documents.warranty_expiry` warns 30 days before `expires_on`, once.
- `unit_documents.retention` deletes an ended occupancy's documents 90 days after its handover (or its end).
- Erasure deletes the account's documents at once.

### The compound's documents (`compound_document_versions`)

**Kinds:** `bylaws`, `occupant_rights`, `conduct_guide`, `moving_guide`.

**Versions:**
- Each is numbered per kind under an advisory lock, and is immutable (trigger).
- Each holds English and Arabic bodies (Markdown, at most 50,000 characters) and an optional signed PDF (purpose `compound_document`).
- From version 2, `changes_en` and `changes_ar` say what the amendment changes.

**A bylaws version must cite the board's published `decision`** (composite FK; `BOARD_PUBLICATION_NOT_FOUND` otherwise). That is its link to governance.

**Routes:**
- Residents and family read with `community.read`: the latest of each kind, a kind's versions, and one version.
- The management publishes, and reads the latest, with `content.manage` (new) under `/staff/compound-documents`.

A new version of the bylaws or the rights tells everyone (`compound_document.published`); the guides do not. The dashboard offers a plain-language template for the rights. There is no seed.

### Contracts and renewals

**`unit_contracts`** (`CT-`): kind `lease` or `ownership`, `signed_on`, `starts_on`, and for a lease `ends_on` and `notice_days`. A lease may also carry a file (purpose `contract`) and `renews_id`.
- **Parties** are rows in `unit_contract_parties`: a lease names tenant occupancies, an ownership contract names owner occupancies. There is no 1:1 with an occupancy.
- **Immutable terms.** Only `voided_at` with its reason, `expiry_notified_at`, and the file's purge may be set, once each (trigger). A correction is a void plus a new contract. A void waits until an open renewal request is declined (`CONTRACT_RENEWAL_OPEN`), so the tenant is told and no request is left on a contract that never was.
- **Live lease.** A tenant occupancy holds at most one live lease (`CONTRACT_LEASE_LIVE`). A lease is live until it is voided or renewed by a contract that is not voided. This is checked under the unit's lock.

**Who sees what:**
- A party always sees their contract, even after leaving.
- The active owners see the unit's leases.
- Nobody else does: not tenants for ownership contracts, not members, not delegates.
- The management needs `contracts.manage` (new).

**Renewals** (`contract_renewals`, `open → renewed | declined | withdrawn`):
- **Who and when.** An active tenant party asks while the lease is live, until its `ends_on` on the compound's calendar. One is open per contract.
- **Renewed.** A request is renewed only by recording the next lease with `renewalRequestId`, in the same transaction.
- **Declined** with a code: `owner_declined`, `dues_outstanding`, `terms_not_agreed`, `other`.
- **Lock order:** the unit, the contract, the renewal.

**What ending costs.** `GET …/contracts/{id}/end-options` shows the notice date (`ends_on − notice_days`) and the settings `renewal_fee` and `move_out_fee` (null until published). The management invoices the fees by hand.

**Sweeps:**
- `contracts.expiry_notice` sends `contract.expiring` once, from the notice date: to the active parties and the active owners.
- `contracts.retention` purges a file 5 years after the end, once no party lives there.
- Erasing a sole party purges the file and keeps the record.

### Clearance certificates (finance)

**`finance_clearances`** (`CL-`), immutable.
- **Who.** An active occupancy asks for one, never a delegate. Staff with `finance.invoice` issue one too.
- **How it is decided.** Under the account FOR SHARE and the unit's finance lock, the unit's outstanding balance is summed over every invoice, **disputed ones included**.
  - Zero: issued, with `as_of = dbNow` and valid for 30 days on the compound's calendar.
  - Anything owed: `409 CLEARANCE_BALANCE_DUE {owed}`.
- **No override.** Settling a deposit against the dues is the way out (below).
- **The PDF.** Only the requester and staff may download it.

**The public check.**
- The certificate prints `<PUBLIC_APP_URL>/c` and a 22-character code. The code is kept on the row, as receipts' codes are, with a global pointer `clearance_links` holding its SHA-256.
- `POST /public/clearances/lookup {code}` answers with the compound, the number, the unit's code, the dates and `valid|expired`. It never shows a name. It is rate-limited per IP.
- `apps/public` serves `/c#<code>`, and `/c` with the code typed in.

### Deposits the management holds (finance)

**`finance_deposits`** (`DP-`) and the append-only **`finance_deposit_events`**.
- **Kinds:** `finishing_works`, `move`, `maintenance_fund`, `other`. A lease deposit between an owner and a tenant is theirs, and stays out.
- **Recording.** `deposits.manage` (new) records one when the money is received.
- **What is held** is computed from the events and never stored.

**Settling:**
- The depositor's account asks for a refund, and may withdraw the ask.
- A manager with `finance.refund` and a fresh step-up settles. A settlement combines a refund (cash or transfer), deductions with codes (`unpaid_dues`, `damage`, `cleaning`, `works_unfinished`, `other`) and a forfeit. The total may not exceed what is held (`DEPOSIT_EXCEEDS_HELD`).
- An `unpaid_dues` deduction becomes an office payment of the new method `deposit_offset`, allocated like any payment, so the unit can then be cleared.

**Locks:** the account FOR SHARE, the unit's finance lock, the deposit FOR UPDATE.

**Erasure.** A held deposit blocks it (`deposit_held`).

### Permissions and roles

| Permission | Kind | Default role |
|---|---|---|
| `profile.contact` | resident and family | resident, family member |
| `unit_documents.manage`, `contracts.manage`, `content.manage`, `deposits.manage` | manager | manager |

### Privacy and audit

- **Audit** holds ids, codes, kinds and counts. A changed name is a sensitive diff. A document's title is not audited.
- **Notifications** are `account.identity_change_decided`, `compound_document.published`, `contract.expiring`, `contract.renewal_decided` and `unit_document.warranty_expiring`. Their parameters hold no document, phone, email or code.
- Every document read is `no-store`, through a presigned URL.

## Consequences

**Migrations** (`20261118090000` to `20261118091300`). Each enum value is in its own migration; then the CHECKs that list purposes or methods are recreated whole:
- `090000`, `090100`: the registration status `needs_correction`, the purpose `registration_document`, the files' `record_upload`, the documents and the global status links;
- `090200`, `090300`: the OTP purpose `contact_change`, then the identity changes;
- `090400`, `090500`: the purpose `kinship_proof`, the scope `permits`, then the invite documents and the setting;
- `090600`, `090700`: the purpose `unit_document`, the scope `documents`, then the vault;
- `090800`, `090900`: the purpose `compound_document`, then the versions;
- `091000`, `091100`: the purpose `contract`, then the contracts, parties, renewals and fee settings;
- `091200`, `091300`: the method `deposit_offset`, then the clearances, deposits, events and the global clearance links. The payments' office and reference CHECKs are recreated to accept the new method.

**New tables:**
- **Eleven tenant tables**, each under RLS, forced, with the UPDATE grant where they are locked.
- **Two global tables** on the allowlist, reached through `GlobalDbService` only.
- Every new CHECK is in the CHECK map.

**This amends:**
- **ADR 0016:** the delegation scopes `permits` and `documents`;
- **ADR 0024:** a registrant's documents, status link and corrections;
- **ADR 0029:** five purposes, and files with no owner for a record;
- **ADR 0046:** a second public check, modelled on receipts;
- **ADR 0049:** a delegate may ask for a permit.

**The manager dashboard gains:**
- a unit's Papers page: contracts, documents, deposits, clearances;
- Lease renewals, Name and phone changes, and Compound documents;
- in Requests, the registrant's documents, the correction dialog and kinship documents.

**`apps/public` gains** `/rs` and `/c`. For `/rs` uploads, a new `UPLOAD_ORIGIN` is allowed in `connect-src` on that page alone.

## Deviations from the request

- **The status link is `/rs`, not `/r`.** `/r` is already the registration form.
- **The clearance check is `POST /public/clearances/lookup {code}`, in finance,** like receipts. It is not a generic `/public/certificates/lookup {number, code}`: R11a has one certificate kind. The code is kept on its row, as a receipt's is.
- **Deposits are not a `ResidentItems` hold.** Their release is the depositor's own refund ask, which R11b's release request would only duplicate.
- **The `requests` delegation scope moves to R11a-2,** with the unit-level requests it would cover.
- **There is no "email taken" race to test.** Emails are not unique across accounts (one person may hold separate accounts, product decision #4). Phone uniqueness is the existing rule, applied at approval.
- **The compound documents' routes take the kind as a query or body field,** not a path segment. Every path parameter in the API is a UUID.
- **A lease's liveness ignores `ends_on`.** A lease past its end with no renewal stays the occupancy's lease until the move-out (R11a-2) ends the occupancy. A new lease for the same occupancy is recorded as its renewal.

## Open

- **SMS.** Once a channel exists, a phone change can be proven by a code, like the email, and stop being a request.
- **A retention-policy table** (R8-5): the periods above are fixed in code.
- **Staging uploads.** `/rs` uploads fail on staging while storage is plain-HTTP MinIO, as the export download does.
