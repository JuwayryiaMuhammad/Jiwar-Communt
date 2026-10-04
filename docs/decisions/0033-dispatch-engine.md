# 0033 — The dispatch engine: specialties, availability, weighted workload, candidate rules, serialization, triggers, no-candidate handling, the role hook

**Status:** Accepted · Phase 5.2

## Context

ADR 0032 gave maintenance manual assignment. 5.2 adds **automatic** assignment: technicians' specialties and availability, a weighted workload, and an engine that picks who takes a queued ticket. It is a service of its own inside `src/maintenance/dispatch/`, so the algorithm can change later without touching the ticket lifecycle (`src/maintenance/tickets/`). 5.1 promised that 5.2 adds tables without changing its tables: every table below is new, `automatic` already existed in `ticket_assignment_type` (and its CHECK fits: a technician, no actor), and the only touch of a 5.1 table is **one index** (below).

## Decisions

### Specialties

- **`specialties`** is compound data like categories: `key` (immutable), `name_ar`, `name_en`, `active`. Never deleted; a retired one is `active: false`. Five are seeded per compound (plumbing, electrical, ac, carpentry, general) by `TenantLifecycle.onCreated` and backfilled by the migration; a unit test keeps code and SQL in step.
- **`category_specialties`** says which specialties can handle a category (many to many); the manager replaces the set (`PUT /maintenance/categories/:id/specialties`, `maintenance.manage`). Each default category is linked to its namesake. A category with **no** specialty can go to any technician.
- **`technician_specialties`** is set by dispatchers (`PUT /maintenance/technicians/:id/specialties`, `tickets.dispatch`), since the supervisor manages the team. The set is replaced; a row that leaves it is switched off (`active: false`), not deleted. Audited with keys (`technician.specialties_changed`, `ticket_category.specialties_changed`, `specialty.created`, `specialty.updated`).
- **Retired specialties count for nobody**, on both sides: a category whose specialties are all retired behaves as one with none, and a technician's retired specialty does not match.
- `GET /maintenance/specialties` is for `tickets.dispatch` (supervisors give technicians their specialties but do not hold `maintenance.manage`); writes need `maintenance.manage`.

### Availability

- **`technician_availability`** is one row per technician: `available` or `unavailable`. **No row is unavailable**: a technician opts in.
- **`technician_availability_history`** is append-only like `ticket_assignments` (SELECT and INSERT for the app, triggers refuse UPDATE, DELETE and TRUNCATE for every role, no foreign keys): from, to, changed by (null = system), a reason code, time. A CHECK requires a reason unless the technician changed their own (guarded against the NULL trap).
- The technician sets their own (`POST /technician/availability`, no reason). A dispatcher may set it with a code from `availabilityChange` (sick, leave, training, other). Deactivation, a freeze, an erasure and **losing `tickets.work`** set it to `unavailable` through the lifecycle hooks, with a system code. Reactivation does not set it back: they opt in again.
- Every write locks the technician's account `FOR NO KEY UPDATE`; the engine shared-locks the account it is about to assign to and re-reads the candidate rules after the lock, so an availability change is ordered before or after an assignment, never inside it.

### Dispatch settings

- **`maintenance_dispatch_settings`**, one row per compound (`maintenance.manage`, audited as `maintenance.dispatch_settings_changed`): `auto_dispatch_enabled`, the status weights (`assigned` 1, `in_progress` 2, `on_hold` **0**) and the priority multipliers (`normal` 1, `urgent` 1.5, `emergency` 3), two decimals each, with CHECK ranges.
- **Automatic dispatch is off in every compound**, new and backfilled. A deploy must not change how an existing compound works, and a new compound has no technician specialties yet, so "on" would only produce an unassignable notice per ticket. The manager turns it on after setting specialties; queued tickets then wait for the next sweep or a dispatcher's `auto-assign`.

### The engine

`DispatchEngine.run(tx, ticketId, trigger)` acts only if the ticket is `new` with no technician, **under its row lock**: run twice, it assigns once. It writes an `automatic` assignment (no actor), the status row (actor null), the same notices as manual assignment (`ticket.assigned` to the technician, `ticket.status_changed` to the reporter), and an attempt row.

- **Candidates:** an active staff account holding `tickets.work`, `available`, with an active specialty that can handle the category (or any, for a category with none), **who never declined this ticket** (any cycle; the `declined` rows of ADR 0032 are what it reads).
- **Workload** is the sum, over a technician's open tickets (`assigned`, `in_progress`, `on_hold`), of status weight × priority multiplier. A completed ticket waits for the reporter, not for them; a ticket is one row with one status and one priority, so nothing counts twice. It is computed in **integer hundredths** (a product in ten-thousandths): no floating-point sum decides a tie. The API shows it in points with two decimals.
- **Choice:** lowest workload; tie, the one whose last assignment is oldest (`max(created_at)` of `ticket_assignments.to_account_id`, any type; never assigned is oldest of all); tie, the lowest id. A total order, tested as pure functions (`workload.ts`).
- **The one 5.1 table touched:** migration `20261008090100` adds the index `ticket_assignments (tenant_id, to_account_id, created_at)` for that tie-break. It changes no column, constraint, trigger, privilege or behaviour, and is its own migration so it is easy to find.
- **After choosing,** the engine shared-locks the chosen account and re-checks every candidate rule on fresh reads; if the technician stopped qualifying in between, it takes the next one.

### Serialization and the lock order

Decisions in a compound are serialized with a transaction-level advisory lock on (tenant, `maintenance.dispatch`), so two tickets created at the same moment never pick the same "least loaded" technician from a view that is one decision old. The order of locks is, everywhere:

1. core's own row locks (a role, the ticket counter);
2. the **dispatch advisory lock**;
3. an account row;
4. a ticket row.

The engine takes the advisory lock first. A caller that locks the ticket itself must call `serialize(tx)` before: the technician's decline does (it would otherwise hold the ticket while a sweep holds the dispatch lock and wants that ticket), and so do the "became available" path and `auto-assign`. A creation takes it last, after the ticket counter row, to hold it as briefly as possible. Manual assignment and deactivation never take the dispatch lock. Concurrent manual assignments are not serialized by it: it orders the _engine's_ decisions, as the brief says.

### Triggers

The engine runs on:

- a **ticket's creation**, both paths, as the last step of the creating transaction (the response shows the assignment);
- a technician's **decline** (the next candidate, never the decliner);
- a technician **becoming available**, by themselves or by a dispatcher: the queued tickets they can take (their specialties, never one they declined), emergency, then urgent, then normal, oldest first within each, `LIMIT 20`, each ticket through the full choice, so the least loaded candidate wins, not automatically the one who just came back;
- a dispatcher's **`POST /maintenance/tickets/:id/auto-assign`**, which ignores `auto_dispatch_enabled` (it is a deliberate request, and the way to try the engine ticket by ticket in a compound where it is still off). `no_candidate` is an answer, not an error;
- the **sweep** `maintenance.dispatch`, a backstop: every compound with automatic dispatch on and not suspended, emergencies first, then the tickets tried least recently (a stuck batch never starves the rest), then the oldest, `LIMIT 100`;
- a technician who can **no longer work**: tickets released by a deactivation, a freeze, an erasure, or a first rejection whose technician cannot take it back (trigger `released`), and tickets released by losing `tickets.work` (`role_lost`).

**Not an escalation:** a second rejection or reopen goes to the dispatchers on purpose (ADR 0032).

With automatic dispatch off the event triggers (creation, decline, release) leave a `skipped` attempt (`auto_dispatch_disabled`), and the sweep and the availability walk do nothing.

**A failure never costs the caller their work.** `attempt` (and the queue walk) run in a `SAVEPOINT`: an error rolls back only the engine's writes, is logged by class, and the sweep retries. So a resident's report, a decline and an availability change stand. The manual `auto-assign` calls `run`, which lets errors out.

**Released tickets are tried after the releasing transaction commits**, in one of their own (`DispatchEngine.afterRelease`, through the after-commit pattern of `AccountLifecycle`; the freeze hook can now hand back after-commit work like the deactivation and erasure hooks). A deactivation, freeze or erasure transaction stays free of the engine, and an emergency does not wait an hour for the sweep.

### No candidate

The ticket stays in the queue. The dispatchers get **`ticket.unassignable`** (normal) or **`ticket.unassignable_emergency`** (critical), **once per ticket and cycle**: sweep retries, a decline, a manual request never repeat it. Two kinds because a notification's priority belongs to its kind (ADR 0027), as with `ticket.emergency`. Params: the number, the unit code (never for a common area), the category key.

**`ticket_dispatch_attempts`** is append-only (no foreign keys): ticket, cycle, trigger, outcome (`assigned`, `no_candidate`, `skipped`), candidate count, chosen technician, a reason code (only for `skipped`), and `notified`. It answers "why wasn't this assigned?" (`GET /maintenance/tickets/:id/dispatch-attempts`) and **drives the once-per-cycle rule**: the engine notifies only if no row with `notified` exists for (ticket, cycle), and a partial unique index on (tenant, ticket, cycle) `WHERE notified` makes it a fact of the table. Every sweep retry is a row (at the default hourly interval, at most 24 a day per stuck ticket). An emergency still notifies the dispatchers at creation (ADR 0032), whatever the engine does. A new compound's tickets with no specialties set are all `no_candidate` at first; that is the prompt to set them.

### Closing the 5.1 gap: losing `tickets.work`

ADR 0032 left a technician whose role lost `tickets.work` holding their tickets until a dispatcher reassigned them. Now:

- **A core hook**, `RoleLifecycle.onPermissionsChanged` / `permissionsChanged(tx, roleId, added, removed)`, like `AccountLifecycle` and `TenantLifecycle`. `RolesService.replacePermissions` calls it after the writes and the version bump, and `PermissionSyncService` once per changed role from its before/after snapshots (so a rename or retirement of `tickets.work` is covered), inside their transactions.
- **Maintenance's handler** (`TechnicianQualification`), when `tickets.work` was lost: takes the dispatch lock, locks every account of the role `FOR NO KEY UPDATE` in id order, makes each `unavailable` (`permission_lost`), releases its open tickets (`released`, `technician_unavailable`, the dispatchers are told, as in ADR 0032) and lets the engine try each again (`role_lost`). Done work (completed, closed) keeps its technician. An assignment in flight holds its technician `FOR SHARE`, so it finishes first and is then released; a later one re-reads the permission and gets `TECHNICIAN_NOT_FOUND`.
- **There is no other path.** An account gets its role when it is created (`AccountWriter`) and never changes it; there is no route to create or delete a role; the `(role, kind)` foreign key pins the type. The two paths that change a role's permissions are the two above.
- **`pnpm access:sync` boots core only** (a deploy step that runs before the app), so no domain handler is registered in that process and the hook reaches nobody there. The dispatch sweep therefore also **reconciles**, in every compound, whatever the dispatch setting: whoever holds tickets in hand without being an active staff account holding `tickets.work` releases them. The immediate path is the PUT; a sync is picked up by the next sweep.

### Endpoints

|  | Permission |
|---|---|
| `GET`, `POST`, `PATCH /maintenance/specialties[/:id]` | `tickets.dispatch` (read), `maintenance.manage` (write) |
| `PUT /maintenance/categories/:id/specialties` | `maintenance.manage` |
| `PUT /maintenance/technicians/:id/specialties` | `tickets.dispatch` |
| `GET`, `POST /technician/availability` | `tickets.work` (the caller's own) |
| `POST /maintenance/technicians/:id/availability` | `tickets.dispatch` |
| `GET`, `PATCH /maintenance/dispatch-settings` | `maintenance.manage` |
| `POST /maintenance/tickets/:id/auto-assign` | `tickets.dispatch` |
| `GET /maintenance/tickets/:id/dispatch-attempts` | `tickets.dispatch` |
| `GET /maintenance/technicians` | `tickets.dispatch`; gains `availability`, `specialties`, `workload` |
| `GET /maintenance/categories` | `maintenance.manage`; gains `specialtyIds` |

No new permission, so `access:sync` has nothing to add.

### Who sees what

Workload, availability (state, since, reason, who), specialties and the attempts are **dispatch's** (`/maintenance/*`). A technician sees only **their own** availability state at `/technician/availability`: never another technician's state, workload, specialties or declines. Residents see none of it, and the resident and technician ticket views are unchanged. The engine reads no personal data: ids, codes, counts and timestamps. The attempt and availability-history rows hold ids and codes only, immutable, with no names; names are joined at read time, so an erased technician renders `{ id, erased: true }`. Notifications carry the number, the unit code and the category key; the audit trail carries keys, ids and numbers (no names, no free text). The availability history has no endpoint in v0.

## Consequences

- This **amends ADR 0032**: its last consequence (a technician whose role loses `tickets.work` keeps their tickets) no longer holds; `automatic` is now written.
- The queue is only as good as the specialties: a compound that turns automatic dispatch on before setting any gets `no_candidate` for every ticket (the dispatch-settings screen should show how many available technicians have specialties first).
- Turning dispatch on does not drain the queue at once: the next sweep (`SWEEP_INTERVAL_MS`, one hour by default) or a dispatcher's `auto-assign` does.
- A sweep holds the dispatch lock for up to 100 tickets, so a creation can wait for it for a moment; creations are otherwise serialized only by the ticket counter.
- A ticket released by a sync of `access:sync` waits for the next sweep, not for the deploy.
