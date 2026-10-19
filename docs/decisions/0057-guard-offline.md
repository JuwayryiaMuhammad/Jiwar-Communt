# 0057 — The gate offline: enrolled devices, a signed bundle per shift, signed uploads recorded at their device time, conflicts flagged and never refused, a revoked device's batches quarantined, sync health

**Status:** Accepted · Phase O1 · Gate card (offline) · implements ADR 0007 for the gate

## Context

A gate cannot stop when its network does. Before this ADR, a guard's phone was online or useless:

- `POST /gate/entries` took a client id and an `occurredAt` up to 24 h back (ADR 0043). It still needed an open shift **at upload**, stamped the **current** shift, and judged the pass, the blocklist and the settings **as of the upload**.
- Patrol scans were offline-ready (ADR 0052): a device time inside the run's lifetime. The track had a 30-minute queue.
- Service vehicles, material entries and child exits took server ids and the server's clock only.

ADR 0007 had offline documented and not implemented. This ADR implements it for the gate: the device decides alone, with what the server gave it, and the server records at sync what physically happened.

**The aims, as stated for O1:**

- no loss: every action the device recorded reaches the server, or its absence is seen;
- no silent security gap: whatever the server knows better than the device, at the instant it happened, is flagged and told;
- never refuse what happened: a person who came in is recorded as in, at their time, even if they should not have been.

**Out of scope:**

- the mobile app itself (its contract is in [`notes/offline.md`](../api/notes/offline.md));
- offline for the household app, the management app or the technician;
- face recognition, OCR and the control room (G8).

**The model is the gate card's:**

- rules are decided under a lock, by the database's clock (`dbNow`), except an action's own instant;
- rows move forward only, guarded by triggers;
- codes are used instead of free text;
- every response is `no-store`;
- every new table is under RLS, forced, with composite foreign keys;
- the audit holds ids, codes and counts only.

**What the server could and could not re-derive** shaped the design:

| Value | Re-derivable? |
|---|---|
| A visitor pass's token and code (ADR 0043) | Yes, under the pass key |
| A resident's JWR2 secret (ADR 0031) | Yes, but a device holding it could forge the QR online |
| A child's card (ADR 0054) | Its stored `SHA-256(label:tenant:token)` is what a device can compute |
| A worker's card and code (ADR 0028) | **No**: a random token, only `HMAC(pepper)` kept. Fixed by D1 below |
| A contractor's ID last four (ADR 0049) | No: `HMAC(pepper)`. Matched at sync (D4) |
| Pickup codes, ID numbers on the blocklist | No. Online only |

**This amends:**

- ADR 0007: implemented for the gate;
- ADR 0028: worker cards derived from a versioned key;
- ADR 0043: an entry replayed by its id claims its key;
- ADR 0052: a patrol scan arrives in an upload;
- ADR 0053: a blocklist match may come from a sync (`offline_sync`);
- ADR 0054: a child's exit offline, the outcome `left_unverified` and the refusal reasons `escort_qr_invalid` and `offline_unverified`;
- ADR 0056: the gate's settings gain `offlineSyncAlertMinutes`.

## Decisions

### 1. Devices

**`gate_devices`**, keyed by the device's own UUID.

- **The device belongs to the compound, not to an account.** A shared gate phone works, and any guard may use it.
- **Its key:** an Ed25519 public key, raw 32 bytes in base64url (43 characters), unique per compound. The private key never leaves the device.
- **Other columns:** an optional label (1–40), who enrolled it, and its revocation (who, when, a `gateDeviceRevoke` code).
- **Health columns:** `bundle_version`, `last_bundle_at`, `last_seen_at`, `last_upload_at`, `acked_seq`, `max_seq`, `pending_count`, and alert stamps (`overdue_alerted_at`, `gap_alerted_at`, `rejection_alerted_at`).
- **A trigger** keeps the key and the enrolment fixed, revokes once, and lets `bundle_version`, `acked_seq` and `max_seq` only grow.

**Enrol: `POST /gate/devices`** (`gate.operate`, no shift needed).

- The device proves it holds the key by signing `jiwar:gate-device-enroll:v1\n<tenantId>\n<deviceId>\n<publicKey>`.
- The same id with the same key answers the same (a retry).
  - The same id with another key is 409 `GATE_DEVICE_EXISTS`.
  - The same key under another id is 409 `DUPLICATE_RESOURCE`.
- At most 50 live devices per compound (409 `GATE_DEVICE_LIMIT_REACHED`). The count is taken under an advisory lock per compound.
- No approval step (D6). The `gate_devices.manage` holders are told (`gate_device.enrolled`) and revoke a device they do not recognise.

**Revoke: `POST /staff/gate/devices/{id}/revoke {reasonCode}`**, under the new permission `gate_devices.manage` (manager and security supervisor).

- Once only: a retry replays, another revocation is 409 `GATE_DEVICE_ALREADY_REVOKED`.
- After it, the device downloads no bundle and sends no heartbeat (403 `GATE_DEVICE_REVOKED`). What it uploads is quarantined (section 6).

**The signed envelope.** Every device call except enrolment (bundle, heartbeat, upload) carries `{deviceId, payload, signature}`:

- `payload` is the base64url of the UTF-8 JSON (at most 96,000 characters);
- `signature` is Ed25519 over `jiwar:gate-device:v1\n` followed by the payload string as sent.

Signing the string as sent means neither side has to agree on a canonical JSON. The payload carries `purpose` (`bundle`, `heartbeat`, `upload`), `tenantId`, `deviceId` and `sentAt`. The guard's bearer token is required as well: the envelope proves the device, the token the person.

Opening an envelope, in the caller's transaction:

1. the device, by its id in this compound (404 `GATE_DEVICE_NOT_FOUND`);
2. the signature (422 `GATE_DEVICE_SIGNATURE_INVALID`);
3. the payload: a JSON object for this purpose, this compound and this device, with a `sentAt`. Otherwise it is 422 `GATE_DEVICE_ENVELOPE_INVALID`, with `params.reason` one of `payload`, `purpose`, `tenant`, `device` or `sent_at`;
4. the device's row FOR UPDATE;
5. `sentAt` within 24 hours of `dbNow`, either way (`sent_at`);
6. **for a bundle and a heartbeat, the replay guard**: the SHA-256 of the signature is kept in `gate_device_envelopes`, unique per device. The same envelope twice is 409 `GATE_DEVICE_ENVELOPE_REPLAYED`.
   - Ed25519 is deterministic, so a resent envelope has the same signature, and a new `sentAt` gives a new one.
   - The sweep `gate.device_envelopes` deletes a row once both its `sent_at` and its receipt are a day old. A replay after that fails step 5 anyway.
   - An upload is not replay-guarded: its batch id, client ids and sequence numbers make a resend answer what it recorded.

**There is no freshness window of minutes** (approval change 4). A device's clock may be wrong by any amount within a day, so it is calibrated instead: **every response a device reads carries `serverTime`**, and the device keeps its offset with a monotonic clock (the notes say how).

### 2. Derived worker cards (D1, key-versioned)

A bundle has to carry a tag of a worker's card and code. Random cards cannot be re-derived, so from now on a card is derived:

```
token = base64url(HMAC-SHA256(key_v, "engagement:<tenantId>:<engagementId>:<seq>"))
code  = deriveCode(token, 8)
```

- **`worker_engagements` gains `token_seq` and `token_key_version`**, set together, both or neither. A reissue raises `token_seq` and takes the current key's version.
- **`ENGAGEMENT_TOKEN_KEYS`** is a keyring (`ver:key[,ver:key…]`, each key at least 32 characters and equal to no other secret). **`ENGAGEMENT_TOKEN_KEY_VERSION`** names the key for new and reissued cards.
- **A rotation never invalidates a printed card.** The old key stays in the ring, and a card is derived with its own version. The stored `HMAC(pepper)` hashes are unchanged, so online verification is exactly as before. A test rotates the key and shows that an old card still verifies online and still lands in a bundle.
- **Cards issued before O1** have no `token_seq`. They keep working online and are left out of bundles. Each bundle counts them (`workersNotDerivable`), and the devices page shows the count (`notCarried`) until they are reissued. Passes the pass key cannot re-derive are counted the same way (`passesNotDerivable`).

### 3. The bundle

**`POST /gate/offline/bundles`**, envelope `purpose: bundle`, for a guard with an open shift at a gate.

- **Lock order:** the guard's account (FOR SHARE), their shift (FOR SHARE), the device (FOR UPDATE), the lockdown row (FOR SHARE), the blocklist (shared). So the snapshot is consistent with every lockdown start and end, and every ban and lift.
- **At most 4 a minute per device** (429).
- **The version** is the device's `bundle_version + 1`, monotonic per device.
- **`issuedAt`** is `dbNow`.
- **`validUntil`** (bundle-rules.ts):
  - the shift's roster slot end plus 30 minutes, at most 24 hours after issue;
  - 12 hours for a shift that filled no slot;
  - 1 hour for a shift already past its slot's end (overtime), renewed while online.
- **The response** is `{keyVersion, body, signature, serverTime}`. `body` is the bundle's JSON in base64url, and `signature` is Ed25519 over `jiwar:gate-bundle:v1\n<body>`.

**The server's keyring.**

- **`GATE_BUNDLE_SIGNING_KEY`** is a 32-byte seed (base64 or base64url), different per environment and equal to no other key.
- **`GATE_BUNDLE_SIGNING_KEY_VERSION`** is the key id.
- **`GATE_BUNDLE_PREVIOUS_PUBLIC_KEYS`** (`ver:pub,…`) holds retired keys' public halves only. An old seed is never kept.
- **`GET /gate/offline/keys`** (`gate.operate`) lists `{version, publicKey, current}` and `serverTime`.
- **A rotation:** set the new seed and version, put the old public key in the previous list for a day (every live bundle expires within it), then drop it. A device fetches the keys when it meets an unknown `keyVersion`.

**What the server keeps:** `gate_offline_bundles` holds the id, device, version, shift, gate, guard, `issued_at`, `valid_until`, key version, the SHA-256 of the body as sent, and the section counts. **Never the contents.**

**What it carries (version 1).** The header is `v`, `bundleId`, `tenantId`, `deviceId`, `version`, `shiftId`, `gateId`, `guardId`, `issuedAt`, `validUntil`, `keyVersion`, `timezone` and `salt`. The sections:

| Section | What | Matched by |
|---|---|---|
| `lockdown` | The lockdown holding the gate at download (`scope`, `since`), or null | — |
| `passes` | Active passes valid during the bundle: kind, party size, entries used, inside, window, schedule, unit code | code, QR, the visitor's plate |
| `workers` | Derived cards whose engagement may come in: capacity, schedule, end date, inside, unit code | code, QR |
| `blocklist` | Active plate entries, `ban` or `watch` | plate |
| `residents` | Live resident credentials | credential id (a JWR2's) |
| `workRules` | The compound's work days and hours (ADR 0049) | — |
| `works` | Approved works permits in force: reference, window, daily hours, `stopped`, how many workers | the reference (typed) |
| `moves` | Approved moves' trucks | plate |
| `events` | Approved events, guests from 30 minutes before to the end | each guest's plate or exact name |
| `serviceVehicles` | Service vehicles inside at download | plate (for the exit) |
| `children` | Live exit controls: card, `mayLeaveAlone`, household adult escorts with their credentials, days, hours and post | card; the adult's credential |

- **Ids are references only (`ref`).** The upload names them and the server resolves them again.
- **Never in a bundle:** a name, a phone, an ID number, a photo, or anything a resident or the management wrote. The PII scan proves the response holds no sentinel name, plate or code in clear.
- **A pass or worker refused at download for good** (used, cancelled, expired, the host no longer inviting, banned, suspended, ended) is left out. One refused only for now (not yet valid, outside its schedule) is carried with its window, for the device to judge at the instant.

**Tags** (offline-tags.ts). Every tag is 16 bytes in base64url (22 characters).

- **Short or guessable values** (a 6-digit visitor code, an 8-digit worker code, a plate key, a guest's name key) are keyed: `HMAC-SHA256(salt, "<kind>:<value>")`. The `salt` is 32 random bytes drawn for this bundle and carried in it. This is the "short codes are keyed HMAC" rule with a key per bundle:
  - the pepper never leaves the server;
  - no tag matches a stored hash;
  - no tag repeats across bundles.
- **Long random values** (pass and worker QR tokens, credential ids, a child card's stored hash) are hashed with a label: `SHA-256("jiwar:offline:v1:<kind>:<bundleId>:<value>")`. This is the "long tokens are SHA-256 with a domain label" rule. Nothing can be guessed back from them.
- **Kinds:**
  - short: `visitor-code`, `worker-code`, `plate`, `guest-name`;
  - long: `visitor-qr`, `worker-qr`, `resident-credential`, `child-card`.
- **The values tagged:**
  - a plate's `plateKey`: the tidied plate without spaces, Arabic-Indic digits as Western ones, أ/إ/آ as ا, ى as ي, ة as ه (ADR 0045);
  - a guest's `nameKey`: Latin lowered, the same Arabic folds, the short vowels, shadda and tatweel removed, whitespace runs as one space, trimmed (ADR 0056).

**The stated risk: short codes and name tags can be brute-forced from an extracted bundle.**

- A 6- or 8-digit code has 10⁶ or 10⁸ values. Whoever extracts a bundle and its salt can try every code against its tags in seconds.
- **Name tags are open to a dictionary attack in the same way** (approval change 5). Guest names come from a small space of common first and family names. An attacker with a list of names can find which of them are on a compound's guest lists while the bundle lives.
- **This is inherent to checking a value without the server**, and it is bounded the same way for both:
  - **validity:** a bundle decides nothing after `validUntil` (24 hours at most, usually the shift). The codes it reveals are those valid in that window; a name reveals that the person is expected at a compound event that day.
  - **revocation:** a lost or stolen device is revoked from the dashboard. It downloads nothing after that, and what it uploads is quarantined.
  - **secure storage:** the device keeps the bundle and its private key in the platform's secure storage (Keychain / Keystore-backed encryption), and deletes a bundle once it expires.
- **The tags are unlinkable:** a per-bundle salt means a tag from one bundle says nothing about another, and nothing about any database row.
- Plates are in the same class as codes, and so are ID-less contractors (section 5, D4). ID numbers on the blocklist, and persons, are never in a bundle: matching them stays online.

### 4. What works offline

| Works offline | How the device knows | At sync |
|---|---|---|
| Visitor pass in / out | code, QR or the visitor's plate | an entry at its device time |
| Worker in / out | code or card; derived cards only | an entry |
| Move truck in / out | plate | an entry on the move |
| Event guest in / out | plate or exact name (D5) | an entry on the guest |
| Contractor in / out | the permit's reference, then the ID's last four typed | the worker found among the permit's (D4) |
| Service vehicle in / out | as online; out by plate | a visit opened or closed at its time |
| Material entry | as online | a material entry |
| Patrol scan | on a run started online | a scan, as the run judges it |
| Child exit | alone with leave, or a household adult whose ID the guard checked (D3) | a pickup record |
| Resident QR | the credential is known: "resident, check ID" (D2) | nothing; residents are never logged |

**Online only:**

- field exceptions, gate requests and approvals, standing instructions;
- lockdown start, end and overrides; SOS and its escalation;
- worker and outside child escorts; pickup codes;
- ID lookups and blocklist persons;
- visitor photos, a run's start, material exits;
- anything a manager decides.

**At a gate the bundle shows locked**, the device lets nobody in. Exits always go out.

**The device never decides with an expired bundle.** Past `validUntil` it shows "offline unavailable: call the gate phone". An action decided anyway is recorded and flagged `bundle_expired`.

### 5. Uploads

**`POST /gate/offline/uploads`**, envelope `purpose: upload`, payload `{batchId, actions[1..100]}`.

- **Who may upload:** any active `gate.operate` account; no shift is needed. What an action records is attributed to its bundle's guard, shift and gate. The batch records who uploaded it.
- **Every action has** `clientId` (UUIDv7), `seq`, `deviceTime`, `bundleId` and `type`, then its own fields (the notes list them).
  - `seq` strictly increases within a batch and across the device's life, from 1.
  - The entry's id is the `clientId`. So an action the device sent online first and lost the answer to is already that entry: the same id online (`POST /gate/entries {id}`) and offline converges on one row.

**Before any action**, the whole batch is refused when:

- the signature does not verify (422 `GATE_DEVICE_SIGNATURE_INVALID`);
- the envelope says something else (422 `GATE_DEVICE_ENVELOPE_INVALID`);
- the payload does not parse (400 `VALIDATION_FAILED`, `fields[]` as `payload.actions.<i>.<field>`);
- the batch id is another device's.

A refusal is audited (`gate_offline.upload_rejected {reason}`), and the management is told (`gate_device.upload_rejected`, critical, at most once per device in 15 minutes). This happens in its own transaction, committed before the error goes out. Nothing else is written.

**The batch** (`gate_offline_batches`) is created once per id: a retry answers what its actions recorded.

- It keeps the SHA-256 of the payload, the action count, `sent_at` and its offset from `received_at`, and its status (`accepted` or `quarantined`). Never the payload.
- An offset beyond 2 minutes flags `clock_skew` once on the batch: the device drifted from its calibration.

**Each action gets its own transaction, in order:**

1. **The same `clientId`** from the same device, with the same `seq` and the same content (the SHA-256 of the action, keys sorted), answers `duplicate`, with what it recorded.
2. **A `clientId` or `seq` another action holds** is `rejected`, with reason `client_id_reused` or `sequence_reused`, and flagged `action_rejected`. The first one stands.
3. **A revoked device:** `quarantined` (section 6).
4. **A bundle this device was not given**, or a subject this compound does not know, cannot have happened: `rejected` (`bundle_unknown`, `subject_unknown`), flagged `action_rejected`.
5. **Everything else is `recorded`** at its instant, with its flags. A contractor no worker matches is `contractor_unresolved`. A patrol scan the run refuses is `patrol_refused`, flagged `patrol_scan_refused`.

**The instant** (offline-rules.ts `whenOf`): `occurredAt` is the device time clamped to [bundle `issuedAt` − 2 min, `receivedAt`].

| Flag | When |
|---|---|
| `clock_skew` | The time was clamped, or it is more than 2 minutes before the previous `seq`'s |
| `bundle_expired` | The time is past the bundle's `validUntil` + 2 min |
| `shift_ended` | The time is past the bundle's shift's end, by the server, + 2 min |

**Rows:**

- **`gate_offline_actions`** holds, per action: type, seq, device time, `occurred_at`, `received_at`, the bundle, the status, the reason, and a link to what it created (entry, service vehicle visit, material entry, patrol scan, child pickup). It never holds a plate, a code, a name or a last four.
- **The created rows are the ordinary ones.** Reports count them by `occurred_at`. An offline row carries `offlineActionId` in its audit metadata (service vehicles, material entries), or `offline: true` (a child's pickup).

**The response** is `{batchId, receivedAt, ackedThroughSeq, results[{clientId, seq, status, reason, flags[], entryId}], serverTime}`.

- `ackedThroughSeq` is the last sequence number received with nothing missing before it. The server walks it forward over what arrived out of order.
- The device may forget everything up to it. Anything above it that it still holds, it resends.

### 6. A revoked device's uploads: quarantined, never discarded (D7)

A revoked device may have recorded real entries before anyone knew it was lost, and it may also be in the wrong hands. Its actions are therefore neither recorded nor dropped:

- **Each action is stored `quarantined`, as sent**, less anything secret: a contractor's `idLast4` is never kept. No entry, visit or pickup is created.
- **One security flag per batch:** `device_revoked_upload`. The keepers are told critically.
- **A manager decides the batch:** `POST /staff/gate/offline/batches/{id}/review {decision}`.
  - `accept`: each action is decided as it would have been at its receipt, through the same path: its instant, `evaluateIn`, its flags, or its rejection. A contractor is then `contractor_unresolved`, since its last four were never kept.
  - `reject`: each action is kept, `rejected` (`quarantine_rejected`).
  - Once only: `GATE_OFFLINE_BATCH_REVIEWED` after that. A batch with nothing quarantined is `GATE_OFFLINE_BATCH_NOT_QUARANTINED`.
- **Either way, the kept body is cleared** at the decision.
- **The audit:** `gate_offline_batch.reviewed {decision, actions, recorded}`, ids and counts only.

### 7. Conflicts: recorded, flagged, never refused

What the device let through is recorded as it happened. What the server knows better, at that instant, becomes a flag (`gate_offline_flags`):

- each flag holds a kind, a class, the batch, the action, the subject (type and id), the gate, the shift, the device, and code and number `params` only;
- it is cleared or reviewed once, guarded by a trigger.

**Validation at sync** uses the online rules, judged at the action's instant:

- an entry `in` goes through the same subject rules as online, with the subject as it stood then. A pass cancelled after the entry was active at it;
- `lockdown.heldAt(T)`, by the lockdown's own times;
- `blocklist.activeAt(T)`, and the blocklist now.

| Flag | Class | When |
|---|---|---|
| `lockdown_entered` | security | A lockdown held the gate at that instant (also told to the guards on shift at that gate) |
| `blocklist_ban_entered` | security | The plate is banned now or was then (also a blocklist match, source `offline_sync`, keepers told) |
| `credential_banned` | security | The worker banned, the permit's work stopped |
| `once_only_reused` | security | A one-time pass already full. The counter stays at its party size, so its CHECK holds. A pass cancelled or expired since keeps its counter closed, and is judged full by its entries in |
| `action_rejected` | security | The action cannot have happened as said, or another holds its id or seq |
| `device_revoked_upload` | security | A revoked device's batch, quarantined |
| `contractor_unresolved` | security | No worker of the permit, or more than one, has those last four: no entry |
| `child_exit_unverified` | security | A child released offline whose escort or leave did not verify (D3) |
| `credential_revoked` | manager | Cancelled, suspended, ended, the host inactive, taken off a permit, not approved |
| `invalid_at_time` | manager | Not yet valid, expired, outside the schedule or the work hours, a day off |
| `capacity_exceeded` | manager | More inside than a recurring pass allows |
| `clock_skew`, `bundle_expired`, `shift_ended` | manager | Section 5 |
| `patrol_scan_refused` | manager | The run refused the scan (its window, its order, a checkpoint reissued) |
| `blocklist_watch_entered` | info | A watched plate (the keepers are told by the blocklist's `watch_matched`) |
| `already_inside` | info | A worker already in |
| `exit_without_entry` | info | Nobody inside. Cleared when the entry it closes arrives |
| `duplicate_inside` | info | A service vehicle's plate already inside: the older visit gets the system's unconfirmed exit at the new entry's time, so the one-inside index holds |

**Alerts go per batch, not per flag** (`OfflineFlags.alertBatch`), to the `gate_devices.manage` holders, with counts only:

- `gate_offline.security_conflict` (critical) for the security flags;
- `gate_offline.conflicts` for the manager's;
- `gate_offline.lockdown_entered` (critical) also to the guards on shift at the gate;
- nobody for the info flags.

Each flag told carries `alerted_at`, so nothing is told twice. The health sweep tells what a crash between the actions and the alert left untold.

**Review:** `POST /staff/gate/offline/flags/{id}/review {reviewCode}`, with a code from `offlineFlagReview` (`confirmed`, `followed_up`, `false_alarm`, `other`). Once only (`GATE_OFFLINE_FLAG_REVIEWED`). Audited as `gate_offline_flag.reviewed {kind, reviewCode}`.

### 8. The other actions

- **Contractors (D4).** The device knows the permit by its reference and asks for the last four of the ID shown. At sync, the server matches them in constant time among the permit's workers (removed ones too: their entry is flagged). The last four are never stored. No match, or two, means no entry: `contractor_unresolved`.
- **Service vehicles.**
  - In: by plate, kind, company, and a unit code or a facility, as online (ADR 0056). A unit or facility the compound does not know is left out.
  - Out: by plate. The visit inside with that plate closes at the device's time, never before it came in. None inside is recorded with nothing to close, and is not reconciled later (its entry may be on another device that never synced).
  - Bans and watches are flagged as for entries.
- **Material entries:** for a unit, at the device's time, during no lockdown (flagged otherwise). An unknown unit is `subject_unknown`. A permit that is not the unit's works permit is left out.
- **Patrol scans:** a checkpoint of the bundle's guard's run, started online, judged as any scan at the device's time (ADR 0052). A refusal is the scan's own code.

### 9. Children offline (D3)

The bundle carries each live exit control's card tag, whether the child may leave alone, and the household adult escorts with their credential tags, days, hours and post. It never carries the child's name or photo. Worker and outside escorts are not carried: the device refuses them offline.

**The device decides:**

- **alone:** released only with leave;
- **with a household adult:** the guard scans the adult's resident QR (`JWR2.`). The device knows the credential is this child's escort's, but cannot check its mac (D2). So **release requires the guard's attestation `idChecked: true`**, recorded on the action. Without it the payload is refused (`payload.actions.<i>.idChecked`).
- **anyone else:** never released offline (`released: false`).

**At sync**, `ChildGateService.recordOffline` records the pickup at the device's time, by the bundle's guard, in the upload's lock order followed by ADR 0054's (the accounts to tell, FOR KEY SHARE in id order; the control FOR UPDATE; the escort FOR SHARE).

| Case | Outcome | Who is told |
|---|---|---|
| Held: alone without leave | `alone_refused` | The household |
| Held: anyone else | `refused`, reason `offline_unverified` | The household (not the keepers: it is the rule offline) |
| Released alone with leave | `left_alone` | As ADR 0054 |
| Released with an adult, the QR verifies at the exit's instant (its step within one either way), the escort valid then and there | `picked_up` | As ADR 0054 |
| Released, but the QR does not verify, or the escort was revoked, out of its days, hours or post, or leave was revoked since | **`left_unverified`**, with why: `escort_qr_invalid`, `not_an_escort`, `escort_inactive`, `outside_validity`, `wrong_post`, `alone_not_allowed` | **The household and the keepers, critically** (`child.unauthorized_pickup`), and a security flag `child_exit_unverified` |

- **`left_unverified` is a new outcome.** The child did leave. Recording it as `refused` would be untrue, and as `picked_up` unsafe.
- The keepers' child alerts (`GET /staff/security/child-alerts`) include it, and show the `outcome`.
- **The action and its flags go with the pickup** (`ON DELETE CASCADE`), 30 days after its time, as ADR 0054's records do. The triggers allow that DELETE only from the cascade.

### 10. Sync health

**Every call a device makes stamps `last_seen_at`:** its enrolment, a bundle, an upload (also `last_upload_at`), a heartbeat.

**`POST /gate/offline/heartbeat`**, envelope `purpose: heartbeat`, payload `{pendingCount}` (how many actions it still holds). It answers `{serverTime, ackedThroughSeq, refreshBundle}`. `refreshBundle` is true when any of these hold:

- the bundle is older than 15 minutes;
- a lockdown started or ended since it was issued;
- the blocklist changed since it was issued.

**The sweep `gate.offline_sync_health`** runs every minute. It takes each device FOR UPDATE SKIP LOCKED, so a device in a call is skipped. It tells the `gate_devices.manage` holders:

- **`gate_device.sync_overdue {minutes}`**, once per outage: a device not seen for `offlineSyncAlertMinutes` while its last bundle is valid and its shift open;
- **`gate_device.sequence_gap {missing}`**, once per gap: a sequence still missing actions that long after the last upload;
- the flags an upload left untold.

**`gate_settings.offline_sync_alert_minutes`** defaults to 15, with bounds 5–240 (`PATCH /staff/gate/settings`, ADR 0056).

**The management's device view** shows:

- the last seen and last upload times;
- the bundle's version and validity, and whether its shift is open;
- `ackedSeq`, `maxSeq`, `missingActions` and `pendingCount`;
- the open flags;
- `notCarried` (passes and worker cards that work online only until reissued).

### 11. Lock order and races

**The order, for every device call:**

1. the account (FOR SHARE);
2. the shift (FOR SHARE): the guard's for a bundle; for an upload, the action's bundle's, ended or not;
3. the device (FOR UPDATE);
4. the batch;
5. the lockdown row (FOR SHARE);
6. the blocklist (advisory, shared);
7. the subject's rows;
8. the counters and settings.

- **A revocation** takes the manager's account, then the device.
- **A batch review** takes every shift of the batch's bundles first, in id order, then the device and the batch.
- **A child's exit** continues with ADR 0054's order after the lockdown.
- **The sweeps** take devices and flags with SKIP LOCKED.
- **Nothing takes a shift or an account after a device**, so there is no cycle.

**The races, tested** (`test/gate/offline-concurrency`, rounds per case; run three times at verification):

1. **An upload and an online entry on the same one-time pass:** one is counted. The other is 409 online, or flagged `once_only_reused` offline. `entries_used` never passes `party_size`.
2. **Two devices with the same once-only code:** one counted, one flagged.
3. **An upload and a revocation, in both orders** (the device lock held from another connection): either recorded before, or quarantined after. Never both, never lost.
4. **An upload and a lockdown start:** flagged exactly when the lockdown's time precedes the action's.
5. **The same batch sent twice at once:** one batch, each action recorded once. The other answers `duplicate`.
6. **A bundle and a lockdown start:** the bundle's `lockdown` agrees with the lockdown's row.
7. **An upload and a blocklist add for the same plate:** flagged when the ban is active at the instant or now.
8. **An offline and an online service vehicle with the same plate:** one inside.
9. **The health sweep and a heartbeat:** alerted once or not at all.

### 12. Entries replayed by id (D8)

`EntriesService.record()`'s path that replays an entry found by its id now claims the request's idempotency key as well. A retry under another key used to answer 500 when the key was later reused. This was fixed in its own commit, because offline and online entries now share ids.

### The manager dashboard

**`/security/gate-devices`** (`gate_devices.manage`):

- each device's state: revoked, quiet for the compound's minutes while on shift, missing actions, flags to look at, or fine;
- its detail;
- revoke, with a reason.

**`/security/offline-flags`:**

- flags by class and status, reviewed with a code;
- the quarantined batches, accepted or rejected;
- the sidebar counts open security flags and pending batches.

The notification sentences link to both pages. The logic is in `components/security/offline-logic.ts`, with `node:test`.

## Privacy

- **Bundles:** the server keeps a hash, a version and counts only. The device keeps a bundle until it expires, in secure storage.
- **Batches and actions** hold no plate, code, name or last four. A service vehicle's plate lives on its visit only, as online. A quarantined action's body drops `idLast4`, and is cleared at the decision.
- **Child exit actions** go with their pickup after 30 days, flags and all.
- **No `Idempotency-Key` on device routes** (client ids do that job), so there are no idempotency bodies. Request bodies are never logged.
- **Envelope digests** are SHA-256 of signatures, kept a day.
- **Audit:**
  - `gate_device.enrolled {labelled}`;
  - `gate_device.revoked {reasonCode}`;
  - `gate_offline.upload_rejected {reason}`;
  - `gate_offline_flag.reviewed {kind, reviewCode}`;
  - `gate_offline_batch.reviewed {decision, actions, recorded}`.

  Ids and codes only. Bundles, batches and actions are their own log.
- **Notifications** carry counts and minutes, never what was entered.

## New tables, permissions, kinds, reasons and sweeps

- **Migrations** `20261106090000`–`20261106090800`:
  - the tables `gate_devices`, `gate_offline_bundles`, `gate_device_envelopes`, `gate_offline_batches`, `gate_offline_actions` and `gate_offline_flags`;
  - `worker_engagements.token_seq` and `token_key_version`;
  - `material_entries (tenant_id, id)` unique;
  - `child_pickup_outcome` gains `left_unverified`, and the pickup CHECKs are recreated;
  - `gate_settings.offline_sync_alert_minutes`;
  - `blocklist_matches.source` gains `offline_sync`.
- **Permission:** `gate_devices.manage` (manager, security supervisor).
- **Notification kinds:**
  - `gate_device.enrolled`;
  - `gate_device.upload_rejected` (critical);
  - `gate_device.sync_overdue`;
  - `gate_device.sequence_gap`;
  - `gate_offline.security_conflict` (critical);
  - `gate_offline.conflicts`;
  - `gate_offline.lockdown_entered` (critical, to the guards on shift).

  All are in category `safety`, except `gate_offline.lockdown_entered` (`guard_duty`).
- **Reason lists:** `gateDeviceRevoke` (`lost`, `stolen`, `replaced`, `retired`, `compromised`, `other`) and `offlineFlagReview`.
- **Sweeps:** `gate.device_envelopes` and `gate.offline_sync_health`.
- **Environment:**
  - `ENGAGEMENT_TOKEN_KEYS` and `GATE_BUNDLE_SIGNING_KEY` are required at boot;
  - `ENGAGEMENT_TOKEN_KEY_VERSION`, `GATE_BUNDLE_SIGNING_KEY_VERSION` and `GATE_BUNDLE_PREVIOUS_PUBLIC_KEYS` are optional.

## Test vectors

Computed independently (Python's `cryptography`), and pinned by the unit specs. The device's tests should reproduce them.

**A device** (RFC 8032's first test key):

| | |
|---|---|
| seed | `nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A` |
| public key | `11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo` |
| tenant | `01a102b6-6253-74a0-92b1-96e7c9d52601` |
| device | `01a102b6-6253-74a0-92b1-9d0f6c2e4a11` |
| enrolment proof | `r66MZZLmCrrpbGNDfUfh28yT4k-kXFtws__Rrm5mlTaUZNj3JRAGlncqQHar5fcPiii1fFyP_QewN4xLB7Y8AQ` |
| heartbeat payload | `eyJwdXJwb3NlIjoiaGVhcnRiZWF0IiwidGVuYW50SWQiOiIwMWExMDJiNi02MjUzLTc0YTAtOTJiMS05NmU3YzlkNTI2MDEiLCJkZXZpY2VJZCI6IjAxYTEwMmI2LTYyNTMtNzRhMC05MmIxLTlkMGY2YzJlNGExMSIsInNlbnRBdCI6IjIwMjYtMTEtMDZUMDk6MDA6MDAuMDAwWiIsInBlbmRpbmdDb3VudCI6MH0` |
| its signature | `_p5YsEOLsEmn5m9NqKgGlcfi6LkvMcmYwXxWvtxB_i8MJf5yZ-twWDgF-y012Z7tR2xv5gmbsKRoYhtawF7oCw` |
| SHA-256 of the signature | `4ceb428902bac27ea7cb1fe1c1c8eead4bb373c56e689e42277b0e783d837086` |

The heartbeat payload decodes to `{"purpose":"heartbeat","tenantId":"01a102b6-6253-74a0-92b1-96e7c9d52601","deviceId":"01a102b6-6253-74a0-92b1-9d0f6c2e4a11","sentAt":"2026-11-06T09:00:00.000Z","pendingCount":0}`.

**The server's bundle signature** (RFC 8032's second test key):

| | |
|---|---|
| seed | `TM0Imyj_ltqdtsNG7BFOD1uKMZ81q6Yk2oz27U-4pvs` |
| public key | `PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw` |
| body | `eyJ2IjoxLCJidW5kbGVJZCI6IjAxYTEwMmI2LTYyNTMtNzRhMC05MmIxLWEwYzRlNWY2MDcxOCJ9` (`{"v":1,"bundleId":"01a102b6-6253-74a0-92b1-a0c4e5f60718"}`) |
| signature | `adaLnWIbdvnfbZ_zoKpG8bJhIqsOcnuI5WaaZ6lJBXfow-oayieYpiZobg2ABJ_UG5SwGclkTnfL0ddlsk6bBg` |

**Tags**, with salt `AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8` (bytes 0–31) and bundle `01a102b6-6253-74a0-92b1-a0c4e5f60718`:

| Kind | Value | Tag |
|---|---|---|
| `visitor-code` | `482913` | `I3qtK8_tJZJFMXIDorsdCA` |
| `worker-code` | `07315528` | `jSC_IDKzOuLTrjGTa8BtpQ` |
| `plate` | `قبط1234` | `oPM3-HUXHVf9hkZWL_nF1A` |
| `guest-name` | `مريم احمد` | `0aKVKqV3D3Lk8wOgCxcyag` |
| `visitor-qr` | `q3Jzx8b7m2Kd9PwS0aLr5TnYc4Ve1Hu6Gi8Fo0Bj2Ek` | `fg7EIPpdDfZsNjjurCumYw` |
| `resident-credential` | `01a102b6-6253-74a0-92b1-9b0320a0f082` | `FFt87NO75HH6EvxevizavQ` |
| `child-card` | `2c74d8b9cfe5563fd20d0eab68e87c05e3cf6e86720d164659e7fba8ac5055f6` | `wNJTVMHiozNEvm6M5vEaCg` |

## Deviations (accepted at approval, or noted while building)

1. **The approval's changes:**
   - worker cards are derived with a versioned keyring (D1);
   - a revoked device's uploads are quarantined, not refused (D7);
   - a child's exit with an adult needs `idChecked` (D3);
   - freshness is replay protection with `sentAt` within 24 h, not ±5 minutes;
   - the name tags' dictionary risk is stated (section 3).
2. **The 1-minute bundle limit became 4 a minute**, so a device that lost a response can retry with a new envelope.
3. **Children's offline records** go 30 days after the exit's device time, as any pickup's `at`.
4. **`left_unverified`** is a new pickup outcome, and the child alerts gain `outcome`.
5. **A service vehicle's exit without its entry** is flagged, and never reconciled when the entry arrives later.
6. **Not offline** beyond the 30-minute track queue: visitor photos, a run's start, material exits (`use`).
7. **The uploader may be any active guard**, not only the bundle's. Attribution comes from the bundle.
8. **A quarantined contractor** cannot be resolved after acceptance, since its last four were never kept.
9. **`gate_entries` gains no device column.** The action row links to the entry instead. Service vehicles and material entries carry the action id in their audit metadata.
10. **Worker cards from before O1** work online only until reissued. The devices page counts them.
11. **The `in` rules are shared with the online path** through `GateSubjects` and the subject as it stood at the instant, rather than a new `evaluateIn` extracted from `record()`.

## Open

- **A JWR3 resident QR with a daily offline mac** (D2), so a device can verify a resident without holding the secret.
- **Pickup QRs under their own prefix** (ADR 0056's open point about `JWP1.`), before outside escorts could ever be carried.
- **Offline field exceptions**, photos and a run's start.
- **Per-device bundle sections** (only the gate's own passes, say), to shrink what an extracted bundle reveals.
- **A manager view of offline entries with their gap** in the gate log (M3).
