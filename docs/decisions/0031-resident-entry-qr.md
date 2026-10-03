# 0031 — The resident's entry QR: derived secrets, 30-second steps, no movement log, the photo

**Status:** Accepted · Phase 4.3

## Context
The gate verifies visitor passes and worker cards (ADR 0028, 0030), but a resident had no way to say "I live here". The guard needs something to scan that works on the resident's phone without a signal, that dies when it is photographed, and that leaves no trace of when the resident came and went.

## Decisions

### A rotating QR, computed on the phone
- The app registers itself once: `POST /me/entry-credentials { deviceName? }` returns `{ id, secret, stepSeconds: 30 }` **once** (no-store). The phone keeps the secret in its secure storage.
- **The QR is `JWR2.<credentialId>.<step>.<mac>`**:
  - `step = floor(unixSeconds / 30)`;
  - `mac = base64url(first 16 bytes of HMAC-SHA256(secret, "<credentialId>.<step>"))`, 22 characters, the key being the secret's 32 raw bytes (the `secret` field is their base64url);
  - it changes every 30 seconds and is computed offline.
- **The server never stores the secret.** It is derived: `secret = HMAC-SHA256(ENTRY_CREDENTIAL_KEY, "entry:<tenantId>:<credentialId>")`. The `entry_credentials` row holds the id, the account, the device name, `created_at`, `revoked_at` and `revoke_reason`: no secret, and no "last used" time (below).
- The server accepts the current step ±1 (clock skew) and nothing older or newer. A screenshot works for at most about 90 seconds, which is an accepted risk: the guard compares the face with the photo (below).
- **Test vectors** for the app's implementation (computed independently of the server code):

  | | |
  |---|---|
  | key | `entry-credential-key-for-the-test-vector!` |
  | tenant id | `01a102b6-6253-74a0-92b1-96e7c9d52601` |
  | credential id | `01a102b6-6253-74a0-92b1-9b0320a0f082` |
  | secret | `SnesZhBDblL80n60Xav3cGPbYlitMYWykaQbezrT0_8` |
  | step 57000000, mac | `Naci2fBCUmF3tcpODWNL7w` |

  The unit test `entry-secrets.spec.ts` pins them.
- At most **3 live credentials per account** (`ENTRY_CREDENTIAL_LIMIT_REACHED`, 409). `GET /me/entry-credentials` lists them (id, device name, creation time); `POST /me/entry-credentials/:id/revoke` revokes one (204; revoking one's own twice is a no-op, anyone else's is `ENTRY_CREDENTIAL_NOT_FOUND`, the same answer as an unknown id).
- **Issuing is idempotent** (`Idempotency-Key`, `@Idempotent({ secret: true })`): a retry derives the same id and secret again, so no body is stored and a lost response never costs one of the three slots.
- **The owner is told.** Issuing sends an inbox notification `entry_credential.issued` (normal priority, no params, target the credential). A stolen account's first move is to register a phone and walk in; the owner sees it and can revoke it from the list. The notice never carries the device name.

### Who gets one
- A new capability flag **`gateEntry`** (ADR 0020): true for an active occupancy that **resides** (owner-resident, tenant) and for an **active adult member with an account**; false for a landlord, a pending or removed member, a minor and an ended occupancy. A death review and a separation do not change it: it is baseline access to one's home.
- Issuing needs `gateEntry` on at least one unit (`NOT_A_RESIDENT`, 403, otherwise), and verify re-checks it at scan time. There is no permission on these routes: the capability decides. Minors have no account and enter with their family.

### When a credential ends
Every live credential of an account is revoked, in the transaction that caused it, and audited (`entry_credential.revoked`, `reasonCode` only):

| Cause | Reason | Hook |
|---|---|---|
| the owner revokes it | `owner` | the endpoint |
| "revoke all sessions" | `sessions_revoked` | `AccountLifecycle.onSessionsRevoked` (new) |
| deactivation | `account_deactivated` | `onDeactivated` |
| freeze | `account_frozen` | `onFrozen` |
| erasure | `account_deactivated` (an erasure deactivates first; `account_erased` is the fallback) | `onErasing` |
| the account no longer lives in any unit | `not_resident` | `AccountLifecycle.onResidenceChanged` (new) |
| the operator rotated `ENTRY_CREDENTIAL_KEY` | `key_rotated` (by hand, below) | none |

- **`onResidenceChanged`** is called by the community domain after the writes of every action that can end a residence: ending an occupancy, turning `resides` off (including tenant → non-residing owner), a sale (after the buyer's own occupancy exists, so an occupant who buys keeps theirs), and ending a membership (also when the household ends). Handlers re-evaluate; they are not told what changed. The gate's handler asks the community for the units where `gateEntry` holds and revokes everything when there are none. A resident who lives in two units keeps theirs when one ends. Verify checks again at every scan, so the hook only stops an old phone coming back to life when the person moves back in.
- `revokeAllMySessions` now runs in a tenant transaction, so the sessions and the credentials end together.
- **A device name is personal data.** It is kept only while the credential is live: revoking clears it (a CHECK says so), so an erasure needs no special step.
- Compound suspension needs nothing: a suspended compound's guards cannot operate.

### Races
No pair of requests may leave a live credential behind a change that should have ended it. Issuing, every revocation hook and "revoke all sessions" take the **account row lock first** and read after it, so each pair is serialized and the later one sees the earlier one's commit. Issuing re-checks, under the lock, that its own session is unrevoked and the account active (an issue that waited while "revoke all sessions" committed fails 401), where the account lives (an issue that waited while the person moved out fails `NOT_A_RESIDENT`), and counts the live credentials (four parallel issues leave three). Tests hold the lock from another connection to prove each case.

### At the gate
- `POST /gate/verify` accepts `{ qr: "JWR2…" }` beside the existing formats, with the same per-guard rate limit and the same need for an open shift.
- **Order, so a forged QR reveals nothing:**
  1. the payload must have the exact shape;
  2. the mac for the claimed step is computed from the derived secret and compared in constant time **before any database read**. A wrong mac, a wrong credential id, another compound's credential (the secret is bound to the guard's compound), a malformed payload: all give the response of an unknown code, byte for byte;
  3. only a genuine mac can say `expired_qr` (a step outside the current one ±1);
  4. then the credential, the account and where it lives, as of now: `account_inactive` (frozen, inactive or erased), `revoked`, `not_resident`.
- A valid result: `{ result: 'valid', subject: 'resident', reason: null, subjectId: null, next: null, display }`, no-store. The `display` object is shared with visitors and workers: for a resident `unitCode` and the visitor and worker fields are null, and
  - `firstName` is the first word of the full name, never the full name, a phone, an email or a document;
  - `unitCodes` are the units where the person lives now (a landlord's units are not among them);
  - `photoUrl` is a presigned GET, or null when they have no photo, so the guard knows to ask for ID.
- An invalid resident result has `display: null`. `subjectId` and `next` are null: there is no entry to record.

### Resident entries are not logged
A resident scan writes **no** `gate_entries` row, no audit entry, no notification and no "last used" time; only the guard-keyed rate-limit counter in Redis (60 seconds, no resident id in it) is touched. The gate confirms identity; it does not track residents' movements. A test compares the row counts before and after, and the `entry_credentials` table has no column that could say when a credential was used. **Any future "who is inside" feature for residents needs an explicit product decision and a retention period.** Issuing and revoking are audited, with no secret and no device name.

### The resident's photo
- A new file purpose `resident_photo` (JPEG, PNG, WebP; 5 MB), uploaded through the files flow (ADR 0029) by accounts with the new permission **`profile.photo`**, which the resident and family roles carry by default (`access:sync` offers it to existing compounds). A guard or a manager cannot upload one.
- `PUT /me/photo { fileId }` sets or replaces it: the caller's own finalized `resident_photo` moves to the account (`accounts.photo_file_id`, like a worker's photo) and the old file is deleted. `DELETE /me/photo` removes it. Both answer 204. Anything that is not the caller's finalized file of that purpose is `FILE_NOT_AVAILABLE` on `fileId`. The account row is locked, so two requests queue.
- **Who sees it:** the person themself (`GET /me` gains `photoUrl` and is now no-store) and **the guard on a valid resident scan**. Not other residents, not in any list, not the manager. Once attached, `GET /files/:id` no longer reaches it. The PII scan proves the object key appears only in the owner's `GET /me`.
- Audit `account.photo_changed` with `{ changed: true }`, never a file id. Erasure drops the pointer and deletes the file in the same transaction (the account's erased shape forbids a photo).

### Key management
`ENTRY_CREDENTIAL_KEY` is the one secret that matters here.
- **What leaking it means:** whoever holds it can compute the secret of any credential id in any compound and so forge a resident QR for a credential that exists. Credential ids are not secret (they are in every QR), so treat it as the key to every compound's door.
- **Where it lives:** the server's environment only (`app.env` on staging, the production secret store): never in the repository, and in CI only the test value of `.env.example`. It must differ per environment, so a staging QR is nothing in production. At least 32 characters; generate it with `openssl rand -base64 48`. Boot refuses a value equal to `IDENTIFIER_PEPPER`.
- **Rotation:** replace the value in the server's environment and restart. **Every credential stops verifying at once, in every compound**, because every secret derives from it: a scan of an old QR answers like an unknown code, and every phone must register again. There is no dual-key window, so rotate in a quiet hour and tell residents beforehand. Procedure:
  1. Deploy the new value (`openssl rand -base64 48`, different from the old one and from `IDENTIFIER_PEPPER`).
  2. Retire the old rows, so the dead phones do not count against the limit of three. As `jiwar_migrator`, once per compound (the tables are under FORCE RLS):

     ```sql
     BEGIN;
     SELECT set_config('app.tenant_id', '<tenant id>', true);
     UPDATE entry_credentials
        SET revoked_at = now(), revoke_reason = 'key_rotated', device_name = NULL
      WHERE revoked_at IS NULL;
     COMMIT;
     ```

     `key_rotated` exists only for this; the app never writes it, and a manual revocation is recorded in the operator's change log, not in the audit trail.
  3. Tell residents to register again (`POST /me/entry-credentials`).
  After a **suspected leak**, do the same at once: until the key is replaced, anyone holding it can forge a QR.
- The key never appears in a response, a log or the audit trail.

## Consequences
- The guard's app gets a third scan result with a face to compare. A resident without a photo shows `photoUrl: null` and the guard asks for ID.
- Phones need a clock within a minute of the server's; the app should say so when a scan is refused as `expired_qr`.
- Core gained two lifecycle hooks and `ObjectStorage` its own module (the accounts module reads photos and `FilesModule` already imports it).
- New environment variable `ENTRY_CREDENTIAL_KEY` is required; `deploy/README.md` lists it for staging.

## Open
- Retention of the photos of deactivated and frozen accounts (ADR 0009 #12 covers retention in general); only erasure removes them today.
- A manager's view of a resident's credentials (to revoke a lost phone for them) is not built; the person revokes their own, or "revoke all sessions".
- A resident with a phone that cannot hold a secret (no smartphone) has no way in yet.
