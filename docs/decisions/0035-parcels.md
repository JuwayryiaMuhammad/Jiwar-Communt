# 0035 — Parcels: received at the gate, told to the unit, handed over against a code

**Status:** Accepted · Phase G1

## Context
Parcels arrive at the gate for residents who are not there. The guard needs to log one in seconds, the unit's residents need to know, and the hand-over must be safe without turning the gate into a record of who is home. This reuses the pass machinery of ADR 0030, the resident QR of ADR 0031, files (ADR 0029), the inbox (ADR 0027) and the gate's shifts and idempotency (ADR 0028). The code lives in `src/gate/parcels/`: a parcel is a gate action and needs the shifts, the verify budget and the community port.

## Decisions

### Receiving
- A guard on an open shift logs a parcel: the **unit code** (must exist, else `UNIT_NOT_FOUND`), the **carrier** from a closed list (`aramex, dhl, fedex, ups, bosta, mylerz, egypt_post, amazon, noon, jumia, talabat, other`), **pieces** (1–20), a required **photo** (new file purpose `parcel_photo`, uploaded through the files flow by `parcels.handle`) and optionally the **recipient name as printed on the label** (≤ 80 chars). `Idempotency-Key` on every guard write.
- Each parcel gets a per-compound number (`number`, from `parcel_counters`, like tickets). Guards and managers see it as the short id.
- **The guard never sees a pickup code.** The code belongs to the residents.
- A parcel for a unit with **nobody eligible** is accepted and held, silently for the guard (telling them would reveal an empty unit). The managers are told at once, once per parcel: `parcel.unclaimable {parcelNumber, unitCode, carrier}`. An occupant who becomes eligible later sees the parcel in `/me/parcels`.

### Who is eligible: the capability `parcels`
- `capabilitiesFor` (ADR 0020) gains `parcels`: an active occupancy that **resides** (owner-resident, tenant) and an **active adult member with an account**. Never a landlord or non-residing owner, a pending or removed member, a minor, or an ended occupancy. A review (death, separation) does not remove it. `holders(unit, 'parcels')` adds "the account is active", so frozen and erased accounts are out. Residents act through this capability, with no permission on their routes (like ADR 0031): a caller who is not eligible for the parcel's unit gets `PARCEL_NOT_FOUND`.
- New permissions: `parcels.handle` (staff, default for the `guard` role) and `parcels.manage` (manager, default for `manager`). `access:sync` brings them to existing compounds.

### One secret per credential, derived from a server key
A parcel has a **holder credential** (the pickup code) and, optionally, one live **delegate credential** (below). Each is a row in `parcel_credentials`.
- Like a pass (ADR 0030): a 32-byte token; the **6-digit code** is `deriveCode(token)`; the QR is `JWP1.<token>`; the server stores only `code_hash = HMAC(pepper, "parcel-code:<tenant>:<code>")` and `qr_token_hash = HMAC(pepper, "parcel-qr:<tenant>:<token>")`, both only while the credential is live (CHECK) and unique among live ones in the compound (partial unique indexes: a holder code and a delegate code can never collide). A collision draws a new token (`attempt + 1`), never a new code.
- **Unlike a pass, the token is derived, not random and then forgotten:** `token = base64url(HMAC(PARCEL_TOKEN_KEY, "parcel:<tenant>:<credentialId>:<attempt>"))`. The residents read the code from the parcel view whenever they need it (no-store), and a retried idempotent request returns the same code. The server stores no token and no code.
- `JWP1` is its own prefix, and the HMAC labels are their own, so a parcel code or QR is never a visitor pass or a worker card on `POST /gate/verify`, and the guard app can route the scan.
- A credential ends with the parcel's leaving `held`, or with its own end (a revoked delegate). Ended rows keep no hashes.
- **`PARCEL_TOKEN_KEY`** is a secret of the same weight as `ENTRY_CREDENTIAL_KEY`: whoever holds it and a credential id can compute that credential's code. Credential ids are never in a response. It must be at least 32 characters, **different per environment, and never equal to `IDENTIFIER_PEPPER` or `ENTRY_CREDENTIAL_KEY`** (boot refuses). Generate it with `openssl rand -base64 48`. Rotation: replace and restart. Every code derived from the old key stops matching its stored hash, so the residents' views show `pickup: null` (and no delegate code) for a parcel whose derived code no longer matches, and a held parcel can then only be handed over by the resident's entry QR, or returned. Rotate in a quiet hour; a re-key tool is deferred (see Open). The key never appears in a response, a log or the audit trail.

### Notifications
- `parcel.arrived {carrier, pieces, receivedAt, unitCode}` to every eligible occupant of the unit, in the receiving transaction. No name, **no code**: the code is read from `GET /me/parcels`.
- `parcel.reminder {carrier, pieces, days, unitCode}` once, at `parcelReminderDays`; `parcel.held_long {parcelNumber, unitCode, carrier, days}` once, to the `parcels.manage` holders, at `parcelManagerDays`.
- `parcel.collected {carrier, pieces, unitCode, method}` to the unit's **other** eligible occupants when it is handed over (not the person who collected it; when the recipient was a delegate's code, all of them). No names. Rejection and delegate changes tell nobody else.
- `parcel.rejected {parcelNumber, carrier}` to the guards: those on an open shift at the parcel's gate now, and each guard who **starts** a shift at that gate later, once per rejected, unreturned parcel (a hook on `ShiftsService.start`).
- `parcel.unclaimable` above. All are `normal`. No personal params exist, so `PERSONAL_PARAMS` is unchanged.

### Handover
A guard on an open shift hands a `held` parcel over, all pieces at once (no partial handover), by:
1. **the parcel's code or QR** (`{code}` or `{qr}`), or
2. **the resident entry QR** (`{residentQr}`, `JWR2`) of an eligible occupant of *that* unit, or
3. **a delegate's code or QR**.
An optional handover photo (`parcel_photo`) can be attached.
- `POST /gate/parcels/lookup {code|qr}` is read-only and says what the code is: the parcel (as the guard sees it), whether the holder or the delegate presented it, and the **delegate's name, only for a valid delegate code**. `POST /gate/parcels/{id}/handover` re-verifies everything under the parcel's lock.
- **Resident QR.** The mac is checked before any database read, exactly in ADR 0031's order, by the same code (`ResidentVerifier`'s checks, now also exposed as `identify`, which returns only the account id). A genuine QR of an account that is not eligible for this unit answers like an unknown code; only a genuine but stale one says `PARCEL_QR_EXPIRED`. The handover records **who received the parcel on the parcel only** (`handed_to_account_id`, an id; the event's method is `resident_qr`). **It creates no gate entry and no movement record**: no `gate_entries` row, no entry credential use, no notification about the scan. ADR 0031 stands; a test compares row counts. The recipient pointer is cleared by the retention sweep with the other personal data.
- **Rate limit and lockout** (ADR 0030 had only the budget). Code attempts are throttled per guard (`PARCEL_CODE_RATE_LIMIT_PER_MINUTE`, 30, a budget of its own so parcels and passes do not starve each other) and **five wrong presentations in ten minutes lock the guard out** of lookup and hand-over until the window ends (429 `RATE_LIMITED`; a forged resident QR counts as wrong, a genuine stale one does not). The shift is checked first. An unknown or malformed code, a code of another parcel, another unit or another compound, and a dead credential are one answer (`PARCEL_CODE_INVALID`), whatever part was wrong. (A parcel id that does not exist is `PARCEL_NOT_FOUND`: ids are random and the guard reads them from the list, so that tells nothing.)

### The delegate
An eligible occupant may authorize **one delegate per parcel**: a name (required, ≤ 80 chars, **no phone**). This issues a separate derived credential that the resident shares. It is revocable until handover.
- Any eligible occupant of the unit may revoke it.
- **A delegate does not outlive its authorizer.** The credential records the account that authorized it. When that account stops holding `parcels` on the unit (an occupancy or membership ends, a residence flag turns off), is deactivated, frozen or erased, the credential ends (`end_reason: authorizer_left`) and a `delegate_revoked` event with actor side `system` is written, in the transaction that caused it, through `AccountLifecycle` (`onResidenceChanged`, `onDeactivated`, `onFrozen`, `onErasing`).
- The guard sees the delegate's name only on the handover screen after a valid delegate code, never in a list or a parcel view.

### "Not mine" and returns
- An eligible occupant rejects a held parcel with a reason code (`not_ours`, `not_expected`, `other`). It becomes `rejected`, and the guards are told (`parcel.rejected`).
- A guard marks a `rejected` parcel `returned` (to the carrier). A guard may also mark a `held` parcel `returned` **after `parcelManagerDays`** (409 `PARCEL_NOT_YET_RETURNABLE` before). The reason code (`rejected`, `unclaimed`) is derived from the state, not sent.

### The API
- The guard (`parcels.handle`, an open shift): `POST /gate/parcels` (receive), `GET /gate/parcels` and `GET /gate/parcels/{id}` (the list defaults to `held` and `rejected`), `POST /gate/parcels/lookup`, `POST /gate/parcels/{id}/handover`, `POST /gate/parcels/{id}/return`. Photos go through `POST /files/uploads` with purpose `parcel_photo`.
- The residents (no permission, the capability decides): `GET /me/parcels`, `GET /me/parcels/{id}`, `POST /me/parcels/{id}/reject`, `POST /me/parcels/{id}/delegate`, `POST /me/parcels/{id}/delegate/revoke`.
- The managers (`parcels.manage`): `GET /parcels`, `GET /parcels/{id}`, `GET` and `PATCH /parcel-settings`.

### Statuses and the event log
- `held` → `handed_over` | `rejected` → `returned`; `held` → `returned`. Every other transition is 409 `PARCEL_STATE_CONFLICT` with the current status.
- `parcel_events` is **append-only** like the audit tables (immutability triggers, no foreign keys, no free text): kind (`received`, `delegate_authorized`, `delegate_revoked`, `handed_over`, `rejected`, `returned`), actor side and account, method, reason code, time. The parcel's own row holds the current state.
- Audited (ADR 0014; ids and reason codes only): `parcel.received`, `parcel.handed_over`, `parcel.rejected`, `parcel.returned`, `parcel.delegate_authorized`, `parcel.delegate_revoked`, `parcel.settings_changed`.

### Settings and sweeps
- Per compound (`parcel_settings`, a row created with the compound and backfilled, edited by `parcels.manage`, audited by diff): `parcelReminderDays` (default 3, 1–30) and `parcelManagerDays` (default 14, 2–90), reminder < manager.
- `gate.parcel_reminders` sends `parcel.reminder` and `parcel.held_long` once each (`reminded_at`, `held_long_at`, claimed under the parcel's lock), one parcel per transaction. **A suspended compound is skipped** (nobody is told while it is locked down).
- `gate.parcel_retention` runs **30 days after handover or return** and deletes the label name, the delegate name, both photos and the recipient pointer. The photo files are marked deleted in the same transaction (audited `file.deleted`, reason `retention`) and the files sweep (ADR 0029) removes the objects and then the rows, as it does for a worker's photo. The parcel row and its events stay. **It also runs for suspended compounds**, like the visitor-data sweep (ADR 0028): personal data does not outlive its period because a compound is locked. A rejected parcel keeps its data until it is returned.
- Both sweeps are idempotent and safe on several instances.

### Privacy
| Who | Sees |
|---|---|
| Guard | unit code, number, carrier, pieces, photo, status, times. **Never** a resident's name, the label name, an account id or the pickup code. The delegate name only after a valid delegate code. |
| Eligible occupants of the unit | their parcels, with the label name, both photos, the delegate's name and the codes. |
| Managers (`parcels.manage`) | all parcels with unit code and status. **No** label name, delegate name or photos. |
- **A photo can show the label.** The guard and the unit's occupants see the parcel photo, which may carry the printed name. Guards are to photograph the parcel, not the label. Managers get no photo.
- Audit and notification params carry no names and no codes. Responses carrying a code or a presigned URL are `no-store`. Handover and delegate requests use `@Idempotent({ secret: true })`, so no delegate name or code lands in `idempotency_keys`.

### Races
Every transition takes **the parcel's row lock first**, then re-reads the status and the credential. Where an account is involved the order is the one of ADR 0034: **account rows first (in id order), then the parcel rows (in id order)**: a resident's write shared-locks their own account before the parcel, and the lifecycle hooks, which run under the account's lock, lock the parcels after it.
- Double handover, handover vs reject, handover vs return: one wins; the loser gets `PARCEL_STATE_CONFLICT`.
- Delegate revoke (or the authorizer leaving) vs a handover by that delegate's code: the handover re-reads the credential under the lock, so after a committed end it answers like an unknown code; an end after a committed handover finds the parcel no longer held.
- Authorizing a delegate vs the authorizer leaving: the authorization shared-locks the account first and re-checks the capability under the lock.
- Two delegates at once: the lock, with a partial unique index behind it.
- Receiving: the counter row's lock serializes numbers and code allocation per compound.
- Sweeps claim with conditional updates under the parcel's lock.

## Consequences
- `PARCEL_TOKEN_KEY` is required; `deploy/README.md` and `.env.example` list it.
- A parcel code cannot be recovered from the database; the residents' views re-derive it.
- Guards need `parcels.handle` (the default `guard` role has it after `access:sync`).
- `ResidentVerifier` gained `identify` (the account of a genuine, current resident QR and nothing else; `verify` shares its checks); `ShiftsService` gained a start hook (`onStarted`); `RateLimitService` gained `exceeded` and `hit`.

## Open
- Rotating `PARCEL_TOKEN_KEY` strands the codes of parcels held at the time; a re-key tool (re-derive and rewrite the hashes of live credentials) is deferred.
- Deferred: lockers, couriers delivering to the door, SMS, push, bulk receiving, partial handover.
