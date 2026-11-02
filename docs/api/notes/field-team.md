# The field team (ADR 0078)

For the technician app and the manager dashboard.

## The roster

The guards' roster, for the technicians. A technician's slot has a `zone` (or `null` for the whole compound), never a gate.

- **Filled by going on duty:** `POST /technician/availability {state: available}` fills the earliest slot whose window takes the moment, from 30 minutes before its start until its end, with `lateMinutes`. Going off (`unavailable`) closes it: `dutyEndedAt` and `overtimeMinutes`.
- **A slot made, or opening, while on duty** is filled on time; the field team sees `dutyStartedAt` set.
- **Absent:** `absentAt` set when not on duty an hour after the slot was due. A later going on duty still fills it.
- **Routes:** `GET /maintenance/my-roster` and `GET /maintenance/my-roster/attendance` for the technician; `/staff/field-team/roster/*` and `/staff/field-team/attendance` for the field team (`field_team.manage`). The guards' `/staff/security/roster/*` never return a technician's rows.

| Error | When |
|---|---|
| 400 `gateId FIELD_NOT_ALLOWED` | A technician's slot or template names a gate. |
| 400 `technicianId GUARD_NOT_ELIGIBLE` | The account is not an active `tickets.work` holder. |
| 409 `ROSTER_OVERLAP` | It would overlap their slots or templates, either crew's. |
| 409 `ROSTER_SLOT_CLOSED` | Cancelling a slot filled on duty, or cancelled. |

## Instructions

The guards' instructions with `audience: technicians`.

- **Sending:** the field team sends at `POST /staff/field-team/instructions {title, body, urgent?, validFrom?, validUntil?}`.
- **Reading:** the technician lists, reads and acknowledges at `/maintenance/instructions`: `status=pending`, `q`, `{id}`, `{id}/acknowledge`.
- **Pushes:** `technician_instruction.issued` and `technician_instruction.urgent` (critical). One reaching a technician when they go on duty shows as pending (`addedVia: on_duty`).

## Calls for help

`POST /maintenance/help-requests {kind, ticketId?, note?}`:
- `kind` is one of `extra_hands`, `expertise`, `parts`, `safety`.
- `ticketId` must be assigned to the caller.
- `note` is 1–500 characters.

`HelpRequestView`:
- **Who:** `requester`, `takenBy` and `helper` (AccountRefs).
- **About:** `ticket {id, number} | null` and `note`.
- **State:** `status` is `open`, `taken`, `resolved` or `cancelled`.
- **When:** `takenAt`, `escalatedAt`, `resolvedAt`, `cancelledAt` and `createdAt`.

| Who | Route |
|---|---|
| Technician | `GET /maintenance/help-requests/mine`: their calls, and those they were sent to help |
| Technician | `POST …/{id}/resolve`: theirs or one they help, once taken |
| Technician | `POST …/{id}/cancel`: theirs, while open or taken |
| Field team | `GET /staff/field-team/help-requests?status=`, `…/{id}` |
| Field team | `POST …/{id}/take {helperId?}`: another active technician, never the caller |
| Field team | `POST …/{id}/resolve` |

**Pushes,** with `params.helpKind` and never the note:
- `technician_help.requested` (critical) goes to the field team.
- `technician_help.taken` goes to the caller.
- `technician_help.assigned` (critical) goes to the helper.
- `technician_help.escalated` (critical) goes to the managers when nobody took the call in 15 minutes.

| Error | When |
|---|---|
| 404 `TECHNICIAN_HELP_NOT_FOUND` | Not found, or not the caller's (or helper's) to act on. |
| 409 `TECHNICIAN_HELP_LIVE` | The technician has a live call already. |
| 409 `TECHNICIAN_HELP_CLOSED {status}` | Taking one not open, resolving one not taken, or calling off one closed. |
| 404 `TICKET_NOT_FOUND` | `ticketId` is not the caller's ticket. |
