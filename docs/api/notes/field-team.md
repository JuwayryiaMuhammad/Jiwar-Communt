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

# Part b (ADR 0090)

## A technician's last known location

Only with the technician's consent, and only at three steps of one of their own tickets. Never continuous.

| Who | Route |
|---|---|
| Technician | `GET /technician/location-consent`: `{consent: {grantedAt} \| null, points[]}`, their own points of the 30 days |
| Technician | `POST /technician/location-consent`: consent; again answers the same |
| Technician | `DELETE /technician/location-consent`: revoke; every point taken goes with it |
| Field team, dispatch | `GET /staff/field-team/technicians/{id}/location`: `{technicianId, consent, last}`, audited |

- **The steps** take an optional body `{location: {latitude, longitude, accuracyMeters?}}`: `POST /technician/tickets/{id}/en-route` (`en_route`), `…/start` (`started`), `…/visits/{visitId}/arrive` (`arrived`; one point though it starts the work). Send a location only once the technician consented; without it the step answers 409 `LOCATION_CONSENT_REQUIRED` and nothing moves. Without a location the steps answer as before.
- **A point:** `moment`, `ticketId`, `ticketNumber`, `latitude`, `longitude` (six decimals kept), `accuracyMeters`, `capturedAt`. Kept 30 days.
- **Never** in a resident's view, a list or a notification. A technician who leaves has their consent revoked by the system, and their points go.

| Error | When |
|---|---|
| 409 `LOCATION_CONSENT_REQUIRED` | A step sent a location without a live consent. |
| 404 `TECHNICIAN_NOT_FOUND` | The id is not a staff account of the compound. |
| 400 `location.latitude INVALID_NUMBER` | Out of −90…90 (longitude −180…180, accuracy 0…10 000 m). |

## Staff certificates

| Who | Route |
|---|---|
| Field team | `GET /staff/field-team/certificates?accountId&state&removed`: soonest expiry first, no paper's link |
| Field team | `POST /staff/field-team/certificates {accountId, kind, title, issuer?, reference?, issuedOn?, expiresOn, fileId?}` |
| Field team | `GET …/{id}` (with `fileUrl`), `PATCH …/{id}` (a new `expiresOn` renews; `fileId: null` removes the paper), `DELETE …/{id}` |
| Staff member | `GET /staff/my-certificates`: their own, with their papers |

- **The paper:** upload with purpose `staff_certificate` (JPEG, PNG, WebP or PDF, 10 MB, `field_team.manage`), then name its `fileId`.
- **`state`** on the compound's today: `valid`, `expiring` (within 30 days), `expired` (from the day after `expiresOn`); `daysLeft`. It blocks nothing.
- **Pushes** to the holder and the field team: `staff_certificate.expiring` (`certificateKind`, `expiresOn`, `daysLeft`) 30 days ahead, `staff_certificate.expires_today` on the day.
- **The compliance calendar** lists them as `source: staff_certificate`, with `holderId` and `holderName`.

| Error | When |
|---|---|
| 400 `accountId CERTIFICATE_HOLDER_NOT_ELIGIBLE` | Not an active staff account. |
| 400 `expiresOn ENDS_BEFORE_START` | Not after `issuedOn`. |
| 400 `fileId FILE_NOT_AVAILABLE` | Not one of the caller's finalized `staff_certificate` files. |
| 404 `STAFF_CERTIFICATE_NOT_FOUND` | Not found, or removed. |

## Peak reinforcement

| Who | Route |
|---|---|
| Field team | `GET /staff/field-team/reinforcement-suggestions?status`, `POST …/{id}/dismiss {reasonCode}` (`reinforcementDismiss`) |
| Field team | `POST /staff/field-team/reinforcement-calls {needed, startsAt, endsAt, zoneId?, suggestionId?}` |
| Field team | `GET …/reinforcement-calls?status`, `GET …/{id}` (with `recipients`), `POST …/{id}/cancel {reasonCode}` (`reinforcementCancel`) |
| Technician | `GET /maintenance/reinforcement-calls` (with `myAnswer`), `POST …/{id}/accept`, `POST …/{id}/decline` |

- **A suggestion** comes with service pressure's rise; the field team decides. It is the inbox item `reinforcement_suggestion`.
- **A call:** 1–10 `needed`; `startsAt` 15 minutes to 12 hours ahead; `endsAt` 1–12 hours after it. It reaches every technician off duty at the send (critical push `reinforcement.called`).
- **Accepting** writes a roster slot of the window (`/maintenance/my-roster` shows it); going on duty fills it. `status`: `open`, `filled` (as many accepted), `closed` (its start came), `cancelled`.

| Error | When |
|---|---|
| 404 `REINFORCEMENT_CALL_NOT_FOUND` | Not found, or it did not reach the technician. |
| 409 `REINFORCEMENT_CALL_CLOSED {status}` | Filled, closed at its start, or called off. |
| 409 `REINFORCEMENT_ANSWERED {answer}` | The technician answered it already. |
| 409 `ROSTER_OVERLAP` | The window overlaps the technician's roster. |
| 409 `REINFORCEMENT_SUGGESTION_DECIDED {status}` | Answered, dismissed or lapsed already. |
