# 0028 — The gate: shifts, passes, approvals, entries

**Status:** Accepted · Phase 4

## Context
The compound's gate is where the community data meets people at the door: guards on shift, visitors invited by a household, uninvited visitors and deliveries the household must answer for, and the domestic workers registered in Phase 2 (ADR 0017). The guard works on a phone, under time pressure, sometimes offline; the household answers from wherever it is; management reads the log afterwards. It is the first domain after `community`, and the first to depend on another domain.

## Decisions

### A domain of its own
- `src/gate/` is a domain (ADR 0015). It imports core freely and the community domain **only through `src/community/index.ts`**, which exports `CommunityGatePort`: units by id and code, `placeIn` (the capabilities of an account on a unit, or null), `holders` and `unitsWhere` (who carries a capability flag), the household's authority, the unit lock, workers' engagements by code and id, the engagement lock, `WorkersAuthority`, and the schedule rules. Every port method takes the gate's transaction. The boundary lint gained nothing but `'gate'` in `DOMAINS`.
- **Capabilities decide** (ADR 0020). Who may invite visitors, who is asked at the gate and who may answer is `visitorsInvite`; who is told when a worker comes and goes is `visitorsNotify`. The gate never re-derives them.

### Guards and shifts
- A `guard` system role (kind `staff`, permission `gate.operate`) is created in every compound, so staff accounts can be created; `POST /accounts` with `type: staff` takes an optional `roleKey` of a staff-kind role (default `guard`), else `ROLE_NOT_FOUND`, so a second staff role later does not change account creation. Managers get `gate.manage` and `gate.read`; residents and family `visitors.invite`.
- A guard acts at the gate only inside an **open shift** at an active gate (403 `NO_OPEN_SHIFT` otherwise, like every disallowed action, ADR 0025). One open shift per guard: checked, and backed by a partial unique index. Deactivating a gate ends its shifts; a guard deactivated, frozen or erased has the shift ended in the same transaction.

### Visitor passes
- A host with `visitorsInvite` on a unit creates a one-time pass (≤ 7 days) or a recurring one (≤ 180 days, a weekly schedule in the compound's time zone, overnight windows included). The **6-digit code is shown once** (`no-store`) and stored only as `HMAC(pepper, "visitor-code:<tenant>:<code>")`, present only while the pass is active (CHECK). A per-unit cap (`maxActiveVisitorPasses`, under the unit lock) bounds the codes in use.
- **A pass follows its host**: it lets someone in only while the host still has `visitorsInvite` on the unit (`host_inactive` otherwise), and a host deactivated, frozen or erased loses their active passes.
- The host sees their passes; the unit's primary sees every pass of the unit, but the visitor name only on their own. The visitor's name and phone live in `visitor_details`, deleted 30 days after the pass ends; nothing else holds them.

### Verify and the log
- `POST /gate/verify` says what a code is, here and now: 6 digits a pass, 8 a worker, looked up by HMAC in this compound only — an unknown code and another compound's code get byte-identical answers. It is read-only apart from the per-guard rate limit, so it takes no `Idempotency-Key`. The guard sees the unit code and the pass kind and party size, or the worker's name and capacity; never a resident, a visitor's name or phone, or a document. It returns `subjectId` and `next` (`in`, or `out` when they are inside).
- **`gate_entries` is append-only** like the audit tables (ADR 0014): `jiwar_app` has SELECT and INSERT, and triggers reject UPDATE, DELETE and TRUNCATE for every role. A correction is a new entry. It has **no foreign keys**, for the same reason as the audit tables: the row must outlive what it names, and a key would make the referenced tables impossible to truncate in the test setup. The service resolves every id in its own tenant transaction before writing; RLS keeps every row in its compound; `visitor_details_id` is a pointer to data that expires.
- An `in` is checked again **at the moment it happened**: a guard may record up to 24 h late (offline) and 5 min ahead; a one-time pass is used by it. An `out` needs an open `in`. Entries of one subject are serialized by a row lock on the subject (the pass, the engagement or the request). A client may send the entry's own UUIDv7 (`id`): a retry records once.
- `GET /gate/inside` lists who is in now (an `in` with no later `out`), so a guard can record the exit of someone who came without a code; no visitor name. `GET /gate/entries` is the manager's log.
- A subject "inside" longer than `GATE_UNCONFIRMED_EXIT_HOURS` (12) gets a `system` exit marked `unconfirmed` (the sweep, under the same subject lock); never a live-in worker, who lives there.

### Approvals
- The guard asks (`POST /gate/approval-requests`) about an uninvited visitor or a delivery (by unit code) or a worker outside the schedule (by engagement). Every account with `visitorsInvite` on the unit gets a **critical** notification (ADR 0027) and may answer.
- **The first decision wins**: decisions run under the request's row lock. **Deny wins over an approval until the entry**: the entry takes the same lock, so a deny either lands before it (the entry is refused, the guard is told critically) or after it (409 `GATE_REQUEST_DECIDED`). An approval lets one entry in, within 30 minutes; a worker's approval waives only the schedule, and the entry stays the worker's (`approval_request_id` on the entry), so attendance and "inside" follow one subject per worker.
- **Nobody answering in time** (`gateRequestTimeoutSeconds`, 180 by default) applies the unit's standing instruction: `allow`, `deny`, `leave_at_gate` for deliveries, or `timed_out` when it is `ask`. The timeout is resolved lazily on every read, decision and entry, and by the `gate.request_timeouts` sweep: the 180 s timeout is far below the sweep interval. `decision_source` records which of household, standing instruction, timeout or guard (a withdrawal) decided.

### Workers at the gate
- A worker's code works while the engagement is active, not banned, not past its end and within the schedule; an off-schedule worker gets `outside_schedule` with the engagement id, for the guard to ask. Their entries and exits tell the unit's `visitorsNotify` holders. `GET /worker-engagements/:id/attendance` gives the days (first in, last out, an unconfirmed exit, whether every visit closed) in the compound's time zone, to the people `WorkersAuthority` allows; dates and times only.

### Idempotency and offline readiness
- `Idempotency-Key` (`core/idempotency`) is claimed **inside the action's own transaction** (`IdempotencyService.claim(tx, resourceRef)`), so the key commits or rolls back with the write. A concurrent duplicate waits on the key's primary key and replays; a duplicate that committed first and makes the action fail on its own rules is replayed too; another request with the key is 409 `IDEMPOTENCY_CONFLICT`. The body is stored after the commit; a body lost to a crash is re-rendered from the resource ref. A route marked `@Idempotent()` that never claims fails with 500. Keys live 24 h.
- **Pass creation keeps its key on the pass**, never a stored body: the code is a secret. A replay returns the same pass **with a fresh code**, and the first code dies. That is rare (a retry of a request that succeeded), audited as `visitor_pass.code_reissued`, and better than a retry that cannot get a usable code at all.
- Offline readiness (ADR 0007) is the client's id on entries, `occurredAt` up to 24 h back, re-validation at that instant, and keys on every gate write. The manager's screen should highlight a large gap between `occurredAt` and `recordedAt`.

### Privacy and audit
- No visitor name, phone or code ever enters audit metadata or a view the guard reads. The names in notifications are scrubbed when the visitor data expires.
- Audited: gates, shifts, instructions, passes (created, cancelled, code reissued) and approvals (requested, decided with its source, reversed, withdrawn). Entries are not audited: they are their own immutable log.

## Consequences
- The guard's app is a short loop: verify → record, or ask → poll → record; `/gate/inside` closes visits without a code.
- Guards log in with OTP by email until an SMS/WhatsApp channel exists (ADR 0009, #3).
- `gate_entries` grows forever, like the audit log; partitioning and retention are deferred with the audit follow-ups (ADR 0009, #6).
- Worker in/out notices reach every residing member; per-account preferences come with the design (ADR 0027).
