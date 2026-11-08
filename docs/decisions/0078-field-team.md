# 0078 — The field team: the technicians' roster and attendance on the guards' one, instructions every technician acknowledges, and a technician's call for help

**Status:** Accepted · M2-12 (part a) · amends ADR 0050 (the roster and the instructions gain a crew and an audience), 0033 (availability is going on and off duty), 0064 (its open "field-team phase", in part)

## Context

The manager's spec asks to lead the field team: who is on duty and when, who came late or not at all, what every technician must read, and what happens when one of them needs help on the spot. The guards have all of it since ADR 0050; the technicians had only their availability (ADR 0033). The owner decided (2026-11-01) that the technicians' shifts and attendance go on the guards' roster, as one roster, and accepted every recommendation of the manager audit (`~/jiwar-verify-logs/manager/01-operations.md`, MO-5). This phase is part a of M2-12; part b (last known location, staff certificates, access reviews, peak reinforcement) is M2-12b.

## Decisions

### One roster, two crews

The roster's templates and slots gain a **crew** (`staff_crew`: `security`, `maintenance`; migration `20270309090100`). Every row so far is the guards'. One engine, one lock, one set of rules (ADR 0050): templates made into slots 28 days ahead, a slot a day at most, the wall-clock end, no overlap under the account's lock, attendance recorded only, no payroll.

- **Eligibility** by crew: `gate.operate` for a guard, `tickets.work` for a technician (`GUARD_NOT_ELIGIBLE`). The lock is the account's, whoever's slot: one account's slots never overlap.
- **A technician's post** is a zone in service, or none for the whole compound; never a gate (`FIELD_NOT_ALLOWED`). The one-post CHECKs say so per crew.
- **Filled by going on duty.** A technician is on duty while available (ADR 0033). Going on duty fills the earliest scheduled slot of theirs whose window takes the moment (30 minutes before its start until its end), with its lateness (late is more than ten minutes, audited `technician_shift.late`). Going off duty closes it: `duty_ended_at`, and the minutes beyond its end as `overtime_minutes`. One open duty slot at a time: one still running keeps them; one already over is closed when the next is filled.
- **A slot made while on duty** (a single slot within the half hour, or a template's) is filled at once, on time. **A slot whose window opens while on duty** is filled by `gate.technician_duty`, every minute: the technician's lock first, then the slot.
- **Absent** as a guard is: not on duty an hour after it was due, marked once by the attendance sweep, never while on duty; the field team is told (`technician_shift.absent`, normal). A later going on duty still fills it: both facts stay.
- **Time on duty outside a slot** is not recorded here: the availability history has it (deviation 2).
- **Technicians do not swap**: a swap is the guards' (the slot trigger refuses it for a technician's).
- **A technician who leaves** (deactivated or erased) has their templates ended and their slots to come cancelled as a guard's, and their open duty closed (going off duty is part of leaving, ADR 0033). A slot on duty is never cancelled.
- **The crews never see each other's rows**: the guards' lists, ends, cancels and attendance, the daily report and an instruction's scheduled recipients read `security` only; the field team's read `maintenance` only.

**Locks.** Going on or off duty arrives through a new core port, `StaffDuty`, in the availability change's transaction, which holds the technician's account row FOR NO KEY UPDATE; the roster then takes the account FOR SHARE (the same transaction) and the roster lock, then the slot FOR UPDATE. The duty sweep takes the same order. The absence sweep and a cancel take the slot alone. So a slot is filled once, absent once, and never both filled and cancelled.

**Routes.** `field_team.manage` (new; the manager and the maintenance supervisor; the permission sync brings it to existing compounds): `GET /staff/field-team/{technicians,zones}`, `POST|GET /staff/field-team/roster/templates`, `POST …/templates/{id}/end`, `POST|GET /staff/field-team/roster/slots`, `POST …/slots/{id}/cancel`, `GET /staff/field-team/attendance`. A technician: `GET /maintenance/my-roster[/attendance]`.

### Instructions to the technicians

An instruction (ADR 0050, 0056) gains the audience **`technicians`** (migration `20270309090200`): no post, every field technician.

- The field team sends, lists, reads and archives them at `/staff/field-team/instructions[/{id}[/archive]]`, with the same words, urgency and valid days as a guard's.
- They reach every active `tickets.work` holder at the send, and a technician going on duty while one is live (`on_duty`), with the instructions' lock shared as a shift start takes it: reached once either way, told once on a day it holds (`technician_instruction.issued`, `.urgent`, category `maintenance`).
- A technician reads and acknowledges theirs at `/maintenance/instructions[/{id}[/acknowledge]]`.
- The guards' staff routes never see the technicians' instructions, nor the field team's the guards'.

### A technician's call for help

`technician_help_requests` (migration `20270309090300`):
- **What:** `extra_hands`, `expertise`, `parts` or `safety`, about one of the caller's own tickets (assigned to them; otherwise `TICKET_NOT_FOUND`) or none, with their own words (500 at most, staff-only).
- **How it moves:** `open → taken → resolved`, or `cancelled` by the caller while open or taken. One live call per technician (`TECHNICIAN_HELP_LIVE`, under the caller's help lock, a partial unique index behind it).
- **The field team takes it** once (`TECHNICIAN_HELP_CLOSED` after), sending another active technician or none; never the caller. The caller, the helper or the field team resolves it once taken.
- **Who is told,** by the closed kind alone, never the note:
  - the field team at once (`technician_help.requested`, critical);
  - the caller when taken;
  - the helper when sent (`technician_help.assigned`, critical);
  - the managers when nobody took it in fifteen minutes (`technician_help.escalated`, critical). The escalation is marked once, by `maintenance.help_escalation` every minute (SKIP LOCKED, judged again under the row, by the database's clock), and the call can still be taken after.
- **When the technician leaves:** a technician who leaves calls off their live call (`by: system`); an erased one's notes are cleared (`technician_help.note_cleared`). The trigger allows that alone.
- **Routes:** a technician (`tickets.work`) has `POST /maintenance/help-requests`, `GET …/mine`, `POST …/{id}/resolve` and `POST …/{id}/cancel`. The field team has `GET /staff/field-team/help-requests[/{id}]`, `POST …/{id}/take` and `POST …/{id}/resolve`.

### Personal data

A technician's export gains `field-team/slots.json` (their duty slots: zone, times, on and off duty, lateness, overtime, absence) and `field-team/help-requests.json` (the calls they made, with their notes; the calls they were sent to help, without the caller's words). The guards' `guard-duty/slots.json` keeps the guards' crew.

## Deviations for the owner

1. **One roster, two crews in the same tables**, rather than a technicians' table copying it: the rules, the lock and the sweeps are the guards', so they cannot drift apart.
2. **Time on duty outside a slot** is not counted as "unscheduled" as a guard's shift is: a technician's availability is not a shift, and its history already records every change.
3. **No swaps for technicians** in this phase.
4. **The escalation delay** is fifteen minutes, fixed, not a compound setting.
5. **A help request's ticket** must be assigned to the caller; a ticket they only see is refused as not found.
6. **The call's notifications** go to every `field_team.manage` holder (the manager included), not to dispatchers (`tickets.dispatch`).

## Consequences

- The manager and the maintenance supervisor see who of the field team is on duty against the roster, who came late, who is absent and the overtime, as for the guards.
- Part b (M2-12b): the last known location at en-route, arrive and start, with consent; staff certificates with expiry; access reviews and dangling-account alerts; peak reinforcement.

## Update (M2-12b, ADR 0090)
- **Part b is built** (ADR 0090): a technician's last known location, taken only with their consent at the three steps (on the way, at the door, starting the work), kept 30 days and read one technician at a time; staff certificates with their expiry, warned of and shown in the compliance calendar, blocking nothing; dangling accounts and access reviews of the compound's side (`accounts.manage`); and peak reinforcement, suggested by service pressure and called by the field team, each acceptance a single roster slot.
- **The roster** gains a writer of single slots through `StaffDuty` (a reinforcement's acceptance): under the technician's roster lock, as any single slot, filled at once when they are on duty within the half hour.
- **The field team's export** gains `field-team/location.json` and `field-team/certificates.json`.
